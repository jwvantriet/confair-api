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
        const rosters      = await fetchRostersForCrew(periodFrom, periodTo, placement.crew_id);
        const items        = rosterItemsList(rosters);
        const rows         = mapRosterToRows(items, placement.crew_id, placement.crew_nia);
        const crewSummary  = buildDailySummary(rows).find(c => c.crewId?.toUpperCase() === placement.crew_id?.toUpperCase());

        logger.info('Roster sync', { placement: placement.full_name, rosterItems: items.length, rows: rows.length, days: crewSummary?.days?.length || 0 });

        if (!crewSummary?.days?.length) { results.push({ placement: placement.full_name, days: 0, items: 0 }); synced++; continue; }

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

    // Get placement names
    const pids = [...new Set((items || []).map(i => i.placement_id))];
    const placementMap = {};
    if (pids.length) {
      const { data: ps } = await adminSupabase.from('placements').select('id, full_name').in('id', pids);
      placementMap = Object.fromEntries((ps || []).map(p => [p.id, p.full_name]));
    }

    // Group by placement
    const byPlacement = new Map();
    for (const item of items || []) {
      const pid = item.placement_id;
      if (!byPlacement.has(pid)) {
        byPlacement.set(pid, { placementId: pid, displayName: placementMap[pid] || 'Unknown', chargeTypes: new Map(), totalValue: 0, currency: item.currency });
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
router.get('/corrections/:periodId', requireCompanyOrAbove, async (req, res, next) => {
  try {
    const { data, error } = await adminSupabase
      .from('charge_corrections')
      .select('*, charge_types(code, label), placements(full_name)')
      .eq('period_id', req.params.periodId)
      .order('created_at', { ascending: false });
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

export default router;
