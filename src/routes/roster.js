/**
 * Roster & Charge Items routes
 */
import { Router } from 'express';
import { adminSupabase } from '../services/supabase.js';
import { requireAuth, requireAgency, requireCompanyOrAbove } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import { fetchRostersForCrew, rosterItemsList, mapRosterToRows, buildDailySummary, monthBounds } from '../services/raido.js';

const router = Router();
router.use(requireAuth);

// Carerix finance typeID → charge type code
const CHARGE_TYPE_MAP = {
  DailyAllowance:      9582,
  AvailabilityPremium: 12308,
  YearsWithClient:     12328,
  PerDiem:             10203,
  GroundFee:           11382,
  SimFee:              10217,
  SoldOffDay:          10062,
  BODDays:             12378,
};

// ── GET /roster/charge-types ──────────────────────────────────────────────────
router.get('/charge-types', async (req, res, next) => {
  try {
    const { data } = await adminSupabase.from('charge_types').select('*').order('sort_order');
    res.json(data || []);
  } catch (err) { next(err); }
});

// ── POST /roster/sync/:periodId ───────────────────────────────────────────────
router.post('/sync/:periodId', requireAgency, async (req, res, next) => {
  try {
    const { periodId } = req.params;

    const { data: period } = await adminSupabase.from('payroll_periods').select('*').eq('id', periodId).single();
    if (!period) throw new ApiError('Period not found', 404);

    const { data: placements } = await adminSupabase
      .from('placements')
      .select('id, placement_ref, full_name, crew_id, crew_nia, carerix_placement_id, user_profile_id')
      .not('crew_id', 'is', null);

    if (!placements?.length) return res.json({ message: 'No placements with crew_id configured', synced: 0 });

    const periodFrom = period.start_date;
    const periodTo   = period.end_date;
    let synced = 0, errors = 0;
    const results = [];

    // Load charge type IDs once
    const { data: chargeTypes } = await adminSupabase.from('charge_types').select('id, code, carerix_type_id');
    const ctByCode = Object.fromEntries((chargeTypes || []).map(ct => [ct.code, ct]));

    for (const placement of placements) {
      try {
        // Check if sync is locked for this placement/period (company has approved corrections)
        const { data: lockStatus } = await adminSupabase
          .from('roster_period_status')
          .select('sync_locked')
          .eq('placement_id', placement.id)
          .eq('period_id', periodId)
          .maybeSingle();

        if (lockStatus?.sync_locked) {
          results.push({ placement: placement.full_name, days: 0, items: 0, skipped: true, reason: 'sync locked by company approval' });
          synced++;
          continue;
        }

        const rosters      = await fetchRostersForCrew(periodFrom, periodTo, placement.crew_id);
        const items        = rosterItemsList(rosters);
        const rows         = mapRosterToRows(items, placement.crew_id, placement.crew_nia);
        const crewSummary  = buildDailySummary(rows).find(c => c.crewId?.toUpperCase() === placement.crew_id?.toUpperCase());

        logger.info('Roster sync', { placement: placement.full_name, rosterItems: items.length, rows: rows.length, days: crewSummary?.days?.length || 0 });

        if (!crewSummary?.days?.length) { results.push({ placement: placement.full_name, days: 0, items: 0 }); synced++; continue; }

        // Write back qualification/active_roles from RAIDO if available
        const qual = crewSummary.qualification;
        const roles = crewSummary.activeRoles;
        if (qual || roles) {
          await adminSupabase.from('placements').update({
            ...(qual  ? { qualification: qual }  : {}),
            ...(roles ? { active_roles: roles }  : {}),
          }).eq('id', placement.id);
        }

        let itemsCreated = 0;

        for (const day of crewSummary.days) {
          // Upsert roster_day
          await adminSupabase.from('roster_days').upsert({
            placement_id: placement.id, period_id: periodId, roster_date: day.date,
            crew_id: placement.crew_id, crew_nia: placement.crew_nia,
            activities: day.activities, is_payable: day.isPayable,
            has_ground: day.hasGround, has_sim: day.hasSim, has_pxp: day.hasPxp,
            sold_off: day.soldOff, bod: day.bod, fetched_at: new Date().toISOString(),
          }, { onConflict: 'placement_id,roster_date', returning: 'minimal' });

          for (const [chargeCode, qty] of Object.entries(day.charges || {})) {
            if (!qty) continue;
            const ct = ctByCode[chargeCode];
            if (!ct) continue;
            await adminSupabase.from('charge_items').upsert({
              placement_id: placement.id, period_id: periodId,
              charge_type_id: ct.id, charge_date: day.date,
              quantity: qty, rate_amount: null, currency: 'USD', total_value: null, status: 'confirmed',
            }, { onConflict: 'placement_id,charge_date,charge_type_id', returning: 'minimal' });
            itemsCreated++;
          }
        }

        results.push({ placement: placement.full_name, days: crewSummary.days.length, items: itemsCreated });
        synced++;
      } catch (e) {
        logger.error('Sync error', { placement: placement.full_name, error: e.message });
        errors++;
      }
    }

    res.json({ message: 'Sync complete', synced, errors, results });
  } catch (err) { next(err); }
});

// ── GET /roster/summary/:periodId ─────────────────────────────────────────────
router.get('/summary/:periodId', async (req, res, next) => {
  try {
    const { periodId } = req.params;
    const { user }     = req;

    // Determine which placements to show
    let placementIds = null; // null = no filter (agency sees all)

    if (user.role === 'placement') {
      const { data: p } = await adminSupabase.from('placements').select('id').eq('user_profile_id', user.id).maybeSingle();
      if (!p) return res.json({ placements: [] });
      placementIds = [p.id];
    } else if (user.role === 'company_admin' || user.role === 'company_user') {
      const { data: company } = await adminSupabase.from('companies').select('id').eq('carerix_company_id', user.carerix_company_id).maybeSingle();
      if (!company) return res.json({ placements: [] });
      const { data: plist } = await adminSupabase.from('placements').select('id').eq('company_id', company.id);
      if (!plist?.length) return res.json({ placements: [] });
      placementIds = plist.map(p => p.id);
    }

    // Fetch charge items
    let q = adminSupabase
      .from('charge_items')
      .select('placement_id, charge_type_id, charge_date, quantity, rate_amount, currency, total_value, status, charge_types(code, label, sort_order)')
      .eq('period_id', periodId)
      .order('charge_date');

    if (placementIds) q = q.in('placement_id', placementIds);

    const { data: items, error } = await q;
    logger.info('Summary query', { periodId, role: user.role, placementIds, count: items?.length, error: error?.message });
    if (error) throw new ApiError(error.message);

    // Fetch all placements in scope (even those with no charges yet)
    let allPlacements = [];
    if (placementIds) {
      const { data: ps } = await adminSupabase.from('placements').select('id, full_name, crew_id').in('id', placementIds);
      allPlacements = ps || [];
    } else {
      // Agency: get all placements that have charge items this period
      const pids = [...new Set((items || []).map(i => i.placement_id))];
      if (pids.length) {
        const { data: ps } = await adminSupabase.from('placements').select('id, full_name, crew_id').in('id', pids);
        allPlacements = ps || [];
      }
    }
    const placementMap = Object.fromEntries(allPlacements.map(p => [p.id, p]));

    // Seed byPlacement with all placements (so zero-charge placements still appear)
    const byPlacement = new Map();
    for (const pl of allPlacements) {
      byPlacement.set(pl.id, { placementId: pl.id, displayName: pl.full_name || '', crewId: pl.crew_id || null, chargeTypes: new Map(), totalValue: 0, currency: 'USD' });
    }

    // Fill in charge items
    for (const item of items || []) {
      const pid = item.placement_id;
      if (!byPlacement.has(pid)) {
        const pl = placementMap[pid];
        byPlacement.set(pid, { placementId: pid, displayName: pl?.full_name || 'Unknown', crewId: pl?.crew_id || null, chargeTypes: new Map(), totalValue: 0, currency: item.currency });
      }
      const p = byPlacement.get(pid);
      const code = item.charge_types?.code;
      if (!p.chargeTypes.has(code)) {
        p.chargeTypes.set(code, { code, label: item.charge_types?.label, quantity: 0, totalValue: 0, currency: item.currency });
      }
      const ct = p.chargeTypes.get(code);
      ct.quantity   += Number(item.quantity   || 0);
      ct.totalValue += Number(item.total_value || 0);
      p.totalValue  += Number(item.total_value || 0);
    }

    res.json({ placements: Array.from(byPlacement.values()).map(p => ({ ...p, chargeTypes: Array.from(p.chargeTypes.values()) })) });
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
      d.totalValue += Number(item.total_value || 0);
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
    // Company admin sees only their placements' corrections
    let query = adminSupabase
      .from('charge_corrections')
      .select('*, charge_types(code, label), placements(full_name), payroll_periods(period_ref)')
      .order('created_at', { ascending: false });

    if (req.params.periodId) query = query.eq('period_id', req.params.periodId);

    if (req.user.role === 'company_admin' || req.user.role === 'company_user') {
      const { data: company } = await adminSupabase
        .from('companies').select('id').eq('carerix_company_id', req.user.carerix_company_id).maybeSingle();
      if (!company) return res.json([]);
      const { data: plist } = await adminSupabase.from('placements').select('id').eq('company_id', company.id);
      const pids = (plist || []).map(p => p.id);
      if (!pids.length) return res.json([]);
      query = query.in('placement_id', pids);
    }

    const { data, error } = await query;
    if (error) throw new ApiError(error.message);
    res.json(data || []);
  } catch (err) { next(err); }
});

// ── PATCH /roster/correction/:id ──────────────────────────────────────────────
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
// Full day-by-day activity view — fetches live from RAIDO for open periods,
// reads from DB for closed/completed periods (payroll frozen).
router.get('/placement/:periodId', async (req, res, next) => {
  try {
    const { periodId } = req.params;
    const { user }     = req;

    // Resolve placement
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
      // Agency/company: pass ?placement_id=xxx
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
    // Cap RAIDO end date to today (API rejects future dates)
    const raidoTo  = periodEnd > today
      ? today.toISOString().split('T')[0]
      : period.end_date;

    let rosterDayMap = {};
    let source = 'db';

    // For open periods with a crew_id, fetch live from RAIDO
    if (isOpen && placement.crew_id) {
      try {
        const rosters = await fetchRostersForCrew(period.start_date, raidoTo, placement.crew_id);
        const items   = rosterItemsList(rosters);
        const rows    = mapRosterToRows(items, placement.crew_id, placement.crew_nia);

        logger.info('Placement RAIDO fetch', {
          crew_id: placement.crew_id, items: items.length, rows: rows.length
        });

        // buildDailySummary returns [{crewId, days:[{date,isPayable,activities,charges,...}]}]
        const crewSummaries = buildDailySummary(rows);
        const crewSummary   = crewSummaries.find(c =>
          c.crewId?.toUpperCase() === placement.crew_id?.toUpperCase()
        ) || crewSummaries[0];

        // Load charge type IDs for DB persistence
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

          // Persist to DB (overwrite — period is open)
          await adminSupabase.from('roster_days').upsert({
            placement_id: placement.id, period_id: periodId, roster_date: day.date,
            crew_id: placement.crew_id, crew_nia: placement.crew_nia,
            activities, is_payable: day.isPayable || false,
            has_ground: day.hasGround || false, has_sim: day.hasSim || false,
            sold_off: day.soldOff || false, bod: day.bod || false,
            fetched_at: new Date().toISOString(),
          }, { onConflict: 'placement_id,roster_date', returning: 'minimal' });

          // Upsert charge items
          for (const [code, qty] of Object.entries(day.charges || {})) {
            if (!qty) continue;
            const ct = ctByCode[code];
            if (!ct) continue;
            await adminSupabase.from('charge_items').upsert({
              placement_id: placement.id, period_id: periodId,
              charge_type_id: ct.id, charge_date: day.date,
              quantity: qty, rate_amount: null, currency: 'USD',
              total_value: null, status: 'confirmed',
            }, { onConflict: 'placement_id,charge_date,charge_type_id', returning: 'minimal' });
          }
        }
        source = 'raido';
      } catch (raidoErr) {
        logger.warn('RAIDO fetch failed, falling back to DB', { error: raidoErr.message });
      }
    }

    // Always fall back to DB for closed periods or RAIDO failures
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

    // Build full month calendar
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
