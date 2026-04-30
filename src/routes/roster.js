/**
 * Roster & Charge Items routes
 *
 * Sync flow (async / poll-based):
 *   POST /roster/sync/:periodId            — creates a sync_runs row, returns
 *                                            { syncRunId } immediately, kicks
 *                                            off runRosterSync in background.
 *   GET  /roster/sync-runs/:syncRunId      — returns current state of the run.
 *   GET  /roster/sync-runs?periodId=…      — list recent runs for a period.
 *
 * Schema note: charge_items has two duplicate column pairs from earlier
 * iterations — `rate_per_unit/total_amount` and `rate_amount/total_value`.
 * All reads here use coalesce-style fallback so older rows keep working.
 */
import { Router } from 'express';
import { adminSupabase } from '../services/supabase.js';
import { requireAuth, requireAgency, requireCompanyOrAbove } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import { fetchRostersForCrew, rosterItemsList, mapRosterToRows, buildDailySummary } from '../services/raido.js';
import { companyIdsForUser, isPlacementActiveInPeriod } from '../services/access.js';
import { runRosterSync } from '../services/roster_sync.js';

const router = Router();
router.use(requireAuth);

// Read either of the two stored "total" columns. Old data may have only one
// populated; new data has both.
const totalOf = (item) =>
  Number(item?.total_value ?? item?.total_amount ?? 0);

// Same trick for the rate columns.
const rateOf = (item) =>
  item?.rate_amount ?? item?.rate_per_unit ?? null;

// ── GET /roster/charge-types ──────────────────────────────────────────────────
router.get('/charge-types', async (req, res, next) => {
  try {
    const { data } = await adminSupabase.from('charge_types').select('*').order('sort_order');
    res.json(data || []);
  } catch (err) { next(err); }
});

// ── POST /roster/sync/:periodId ──────────────────────────────────────────────
router.post('/sync/:periodId', requireAgency, async (req, res, next) => {
  try {
    const { periodId } = req.params;

    const { data: period, error } = await adminSupabase
      .from('payroll_periods').select('id').eq('id', periodId).maybeSingle();
    if (error || !period) throw new ApiError('Period not found', 404);

    const { data: runRow, error: insErr } = await adminSupabase.from('sync_runs').insert({
      kind: 'roster_sync',
      period_id: periodId,
      triggered_by: req.user?.id || null,
      status: 'running',
    }).select('id').single();
    if (insErr || !runRow) throw new ApiError(`Failed to create sync run: ${insErr?.message || 'unknown'}`, 500);

    runRosterSync({ periodId, syncRunId: runRow.id })
      .catch(err => logger.error('runRosterSync crashed at top level', { syncRunId: runRow.id, error: err.message }));

    res.status(202).json({ syncRunId: runRow.id, status: 'running' });
  } catch (err) { next(err); }
});

router.get('/sync-runs/:syncRunId', requireAgency, async (req, res, next) => {
  try {
    const { syncRunId } = req.params;
    const { data: run, error } = await adminSupabase
      .from('sync_runs')
      .select('id, kind, period_id, status, started_at, ended_at, last_step, placements_total, placements_synced, placements_errors, items_created, error_message, event_count, raw_events')
      .eq('id', syncRunId)
      .maybeSingle();
    if (error) throw new ApiError(error.message, 500);
    if (!run)  throw new ApiError('Sync run not found', 404);

    const sinceCursor = req.query.since ? Number(req.query.since) : 0;
    const allEvents   = Array.isArray(run.raw_events) ? run.raw_events : [];
    const events      = sinceCursor > 0
      ? allEvents.filter((e) => (e.ts || 0) > sinceCursor)
      : allEvents.slice(-200);

    res.json({
      ...run,
      raw_events: events,
      total_events: allEvents.length,
    });
  } catch (err) { next(err); }
});

router.get('/sync-runs', requireAgency, async (req, res, next) => {
  try {
    const periodId = req.query.periodId;
    let q = adminSupabase
      .from('sync_runs')
      .select('id, kind, period_id, status, started_at, ended_at, last_step, placements_total, placements_synced, placements_errors, items_created, event_count')
      .order('started_at', { ascending: false })
      .limit(20);
    if (periodId) q = q.eq('period_id', periodId);
    const { data, error } = await q;
    if (error) throw new ApiError(error.message, 500);
    res.json(data || []);
  } catch (err) { next(err); }
});

// ── GET /roster/summary/:periodId ─────────────────────────────────────────────
router.get('/summary/:periodId', async (req, res, next) => {
  try {
    const { periodId } = req.params;
    const { user }     = req;

    const { data: period } = await adminSupabase
      .from('payroll_periods').select('id, start_date, end_date')
      .eq('id', periodId).maybeSingle();
    if (!period) return res.json({ placements: [] });

    let placementIds = null;

    if (user.role === 'placement') {
      const { data: p } = await adminSupabase.from('placements')
        .select('id, start_date, end_date').eq('user_profile_id', user.id).maybeSingle();
      if (!p || !isPlacementActiveInPeriod(p, period)) return res.json({ placements: [] });
      placementIds = [p.id];
    } else if (user.role === 'company_admin' || user.role === 'company_user') {
      const companyIds = await companyIdsForUser(user);
      if (!companyIds?.length) return res.json({ placements: [] });
      const { data: plist } = await adminSupabase.from('placements')
        .select('id, start_date, end_date').in('company_id', companyIds);
      const active = (plist || []).filter(p => isPlacementActiveInPeriod(p, period));
      if (!active.length) return res.json({ placements: [] });
      placementIds = active.map(p => p.id);
    }

    let q = adminSupabase
      .from('charge_items')
      // Select BOTH column pairs so totalOf can fall back.
      .select('placement_id, charge_type_id, charge_date, quantity, rate_amount, rate_per_unit, currency, total_value, total_amount, status, charge_types(code, label, sort_order)')
      .eq('period_id', periodId)
      .order('charge_date');

    if (placementIds) q = q.in('placement_id', placementIds);

    const { data: items, error } = await q;
    if (error) throw new ApiError(error.message);

    let allPlacements = [];
    if (placementIds) {
      const { data: ps } = await adminSupabase.from('placements').select('id, full_name, crew_id').in('id', placementIds);
      allPlacements = ps || [];
    } else {
      const pids = [...new Set((items || []).map(i => i.placement_id))];
      if (pids.length) {
        const { data: ps } = await adminSupabase.from('placements').select('id, full_name, crew_id').in('id', pids);
        allPlacements = ps || [];
      }
    }
    const placementMap = Object.fromEntries(allPlacements.map(p => [p.id, p]));

    const byPlacement = new Map();
    // Seed every in-scope placement with a 0-row so the UI can render zeros
    // for placements that had no charges this period (cleaner than missing rows).
    for (const pl of allPlacements) {
      byPlacement.set(pl.id, {
        placementId: pl.id,
        displayName: pl.full_name || '',
        crewId:      pl.crew_id || null,
        chargeTypes: new Map(),
        totalValue:  0,
        currency:    'USD',
      });
    }

    for (const item of items || []) {
      const pid = item.placement_id;
      if (!byPlacement.has(pid)) {
        const pl = placementMap[pid];
        byPlacement.set(pid, {
          placementId: pid,
          displayName: pl?.full_name || 'Unknown',
          crewId:      pl?.crew_id || null,
          chargeTypes: new Map(),
          totalValue:  0,
          currency:    item.currency || 'USD',
        });
      }
      const p = byPlacement.get(pid);
      const code = item.charge_types?.code;
      if (!p.chargeTypes.has(code)) {
        p.chargeTypes.set(code, {
          code,
          label:      item.charge_types?.label,
          quantity:   0,
          totalValue: 0,
          currency:   item.currency || 'USD',
        });
      }
      const ct  = p.chargeTypes.get(code);
      const val = totalOf(item);
      ct.quantity   += Number(item.quantity || 0);
      ct.totalValue += val;
      p.totalValue  += val;
    }

    res.json({
      placements: Array.from(byPlacement.values()).map(p => ({
        ...p,
        chargeTypes: Array.from(p.chargeTypes.values()),
      })),
    });
  } catch (err) { next(err); }
});

// ── GET /roster/daily/:periodId/:placementId ──────────────────────────────────
router.get('/daily/:periodId/:placementId', async (req, res, next) => {
  try {
    const { periodId, placementId } = req.params;

    if (req.user.role === 'placement') {
      const { data: p } = await adminSupabase.from('placements').select('id').eq('user_profile_id', req.user.id).maybeSingle();
      if (!p || p.id !== placementId) throw new ApiError('Access denied', 403);
    }

    const { data: items } = await adminSupabase
      .from('charge_items')
      .select('*, charge_types(code, label, sort_order)')
      .eq('period_id', periodId)
      .eq('placement_id', placementId)
      .order('charge_date');

    const { data: corrections } = await adminSupabase
      .from('charge_corrections')
      .select('*, charge_types(code, label)')
      .eq('period_id', periodId)
      .eq('placement_id', placementId);

    const byDate = new Map();
    for (const item of items || []) {
      if (!byDate.has(item.charge_date)) byDate.set(item.charge_date, { date: item.charge_date, charges: [], totalValue: 0 });
      const d = byDate.get(item.charge_date);
      d.charges.push(item);
      d.totalValue += totalOf(item);
    }

    res.json({ days: Array.from(byDate.values()), corrections: corrections || [] });
  } catch (err) { next(err); }
});

// ── POST /roster/correction ───────────────────────────────────────────────────
router.post('/correction', async (req, res, next) => {
  try {
    const { periodId, correctionDate, chargeTypeId, reason } = req.body;
    if (!periodId || !correctionDate || !reason) throw new ApiError('periodId, correctionDate and reason are required', 400);

    const { data: placement } = await adminSupabase.from('placements').select('id').eq('user_profile_id', req.user.id).maybeSingle();
    if (!placement) throw new ApiError('No placement found for this user', 404);

    const { data, error } = await adminSupabase.from('charge_corrections').insert({
      placement_id: placement.id, period_id: periodId, correction_date: correctionDate,
      charge_type_id: chargeTypeId || null, reason, status: 'pending', requested_by: req.user.id,
    }).select().single();

    if (error) throw new ApiError(error.message);
    res.status(201).json(data);
  } catch (err) { next(err); }
});

// ── GET /roster/corrections/:periodId ─────────────────────────────────────────
router.get('/corrections/:periodId?', requireCompanyOrAbove, async (req, res, next) => {
  try {
    let query = adminSupabase
      .from('charge_corrections')
      .select('*, charge_types(code, label), placements(full_name), payroll_periods(period_ref)')
      .order('created_at', { ascending: false });

    if (req.params.periodId) query = query.eq('period_id', req.params.periodId);

    if (req.user.role === 'company_admin' || req.user.role === 'company_user') {
      const companyIds = await companyIdsForUser(req.user);
      if (!companyIds?.length) return res.json([]);
      const { data: plist } = await adminSupabase.from('placements').select('id').in('company_id', companyIds);
      const pids = (plist || []).map(p => p.id);
      if (!pids.length) return res.json([]);
      query = query.in('placement_id', pids);
    }

    const { data, error } = await query;
    if (error) throw new ApiError(error.message);
    res.json(data || []);
  } catch (err) { next(err); }
});

router.patch('/correction/:id', requireCompanyOrAbove, async (req, res, next) => {
  try {
    const { status, reviewNote } = req.body;
    if (!['approved', 'rejected'].includes(status)) throw new ApiError('status must be approved or rejected', 400);
    const { data, error } = await adminSupabase
      .from('charge_corrections')
      .update({ status, review_note: reviewNote, reviewed_by: req.user.id, updated_at: new Date().toISOString() })
      .eq('id', req.params.id).select().single();
    if (error) throw new ApiError(error.message);
    res.json(data);
  } catch (err) { next(err); }
});

// ── GET /roster/placement/:periodId ─────────────────────────────────────────
router.get('/placement/:periodId', async (req, res, next) => {
  try {
    const { periodId } = req.params;
    const { user }     = req;

    let placement;
    if (user.role === 'placement') {
      const { data: p } = await adminSupabase
        .from('placements')
        .select('id, crew_id, crew_nia, full_name')
        .eq('user_profile_id', user.id)
        .maybeSingle();
      if (!p) return res.json({ days: [], source: 'none' });
      placement = p;
    } else {
      const pid = req.query.placement_id;
      if (!pid) return res.status(400).json({ error: 'placement_id required' });
      const { data: p } = await adminSupabase
        .from('placements')
        .select('id, crew_id, crew_nia, full_name')
        .eq('id', pid)
        .maybeSingle();
      if (!p) return res.json({ days: [], source: 'none' });
      placement = p;
    }

    const { data: period } = await adminSupabase
      .from('payroll_periods').select('*').eq('id', periodId).single();
    if (!period) return res.json({ days: [], source: 'none' });

    const today    = new Date();
    const isOpen   = period.status === 'open';
    const periodEnd = new Date(period.end_date);
    const raidoTo  = periodEnd > today
      ? today.toISOString().split('T')[0]
      : period.end_date;

    let rosterDayMap = {};
    let source = 'db';

    if (isOpen && placement.crew_id) {
      try {
        const rosters = await fetchRostersForCrew(period.start_date, raidoTo, placement.crew_id);
        const items   = rosterItemsList(rosters);
        const rows    = mapRosterToRows(items, placement.crew_id, placement.crew_nia);
        const crewSummaries = buildDailySummary(rows);
        const crewSummary   = crewSummaries.find(c =>
          c.crewId?.toUpperCase() === placement.crew_id?.toUpperCase()
        ) || crewSummaries[0];

        const { data: chargeTypes } = await adminSupabase
          .from('charge_types').select('id, code');
        const ctByCode = Object.fromEntries((chargeTypes || []).map(ct => [ct.code, ct]));

        for (const day of (crewSummary?.days || [])) {
          const activities = (day.activities || []).map(r => ({
            ActivityCode:    r.ActivityCode,
            ActivityType:    r.ActivityType,
            ActivitySubType: r.ActivitySubType,
            start_activity:  r.start_activity,
            end_activity:    r.end_activity,
            aBLH:            r.aBLH ?? null,
            Designator:      r.Designator,
          }));

          rosterDayMap[day.date] = {
            activities,
            isPayable: day.isPayable || false,
            charges:   day.charges   || {},
          };

          await adminSupabase.from('roster_days').upsert({
            placement_id: placement.id, period_id: periodId, roster_date: day.date,
            crew_id: placement.crew_id, crew_nia: placement.crew_nia,
            activities, is_payable: day.isPayable || false,
            has_ground: day.hasGround || false, has_sim: day.hasSim || false,
            sold_off: day.soldOff || false, bod: day.bod || false,
            fetched_at: new Date().toISOString(),
          }, { onConflict: 'placement_id,roster_date', returning: 'minimal' });

          // Note: this live view writes quantity-only rows (no rates). It runs
          // when an open period is being viewed. To avoid clobbering rates
          // that the sync wrote, we DON'T overwrite rate/total columns here —
          // we use a partial upsert that only sets quantity.
          //
          // (PG/PostgREST doesn't support "update only these columns on
          // conflict" via supabase-js, so we instead skip this write when a
          // sync row already exists. If no sync has run yet, write a stub.)
          for (const [code, qty] of Object.entries(day.charges || {})) {
            if (!qty) continue;
            const ct = ctByCode[code];
            if (!ct) continue;
            const { data: existing } = await adminSupabase
              .from('charge_items')
              .select('id, rate_amount, rate_per_unit')
              .eq('placement_id', placement.id)
              .eq('period_id', periodId)
              .eq('charge_date', day.date)
              .eq('charge_type_id', ct.id)
              .maybeSingle();
            if (existing && (existing.rate_amount != null || existing.rate_per_unit != null)) {
              // Sync row already has a rate — leave it alone.
              continue;
            }
            await adminSupabase.from('charge_items').upsert({
              placement_id:   placement.id,
              period_id:      periodId,
              charge_type_id: ct.id,
              charge_date:    day.date,
              quantity:       qty,
              rate_per_unit:  null,
              rate_amount:    null,
              total_amount:   null,
              total_value:    null,
              currency:       'USD',
              status:         'confirmed',
            }, { onConflict: 'placement_id,charge_date,charge_type_id', returning: 'minimal' });
          }
        }
        source = 'raido';
      } catch (raidoErr) {
        logger.warn('RAIDO fetch failed, falling back to DB', { error: raidoErr.message });
      }
    }

    if (source === 'db' || Object.keys(rosterDayMap).length === 0) {
      const { data: rosterDays } = await adminSupabase
        .from('roster_days')
        .select('roster_date, activities, is_payable')
        .eq('placement_id', placement.id)
        .eq('period_id', periodId)
        .order('roster_date');

      const { data: chargeItems } = await adminSupabase
        .from('charge_items')
        .select('charge_date, quantity, charge_types(code)')
        .eq('placement_id', placement.id)
        .eq('period_id', periodId);

      const chargeByDate = {};
      for (const ci of chargeItems || []) {
        if (!chargeByDate[ci.charge_date]) chargeByDate[ci.charge_date] = {};
        chargeByDate[ci.charge_date][ci.charge_types?.code] = Number(ci.quantity || 0);
      }

      for (const rd of rosterDays || []) {
        rosterDayMap[rd.roster_date] = {
          activities: rd.activities || [],
          isPayable:  rd.is_payable || false,
          charges:    chargeByDate[rd.roster_date] || {},
        };
      }
    }

    const days = [];
    const start = new Date(period.start_date);
    const end   = new Date(period.end_date);

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr  = d.toISOString().split('T')[0];
      const rd       = rosterDayMap[dateStr];
      const isFuture = d > today;

      days.push({
        date:       dateStr,
        isFuture,
        isPayable:  rd?.isPayable || false,
        activities: rd?.activities || [],
        charges:    rd?.charges || {},
      });
    }

    res.json({ days, period, source });
  } catch (err) { next(err); }
});

export default router;
