/**
 * Roster Payroll Workflow Routes
 * Handles the 5-step approval workflow for roster-based payroll
 */
import { Router } from 'express';
import { adminSupabase } from '../services/supabase.js';
import { requireAuth, requireAgency, requireCompanyOrAbove } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import { fetchRostersForCrew, rosterItemsList, mapRosterToRows, buildDailySummary } from '../services/raido.js';

const router = Router();
router.use(requireAuth);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getRosterPeriodStatus(placementId, periodId) {
  const { data } = await adminSupabase
    .from('roster_period_status')
    .select('*')
    .eq('placement_id', placementId)
    .eq('period_id', periodId)
    .maybeSingle();
  return data;
}

async function upsertRosterPeriodStatus(placementId, periodId, updates) {
  const { data, error } = await adminSupabase
    .from('roster_period_status')
    .upsert({ placement_id: placementId, period_id: periodId, ...updates, updated_at: new Date().toISOString() },
      { onConflict: 'placement_id,period_id', returning: 'representation' })
    .select()
    .single();
  if (error) throw new ApiError(error.message);
  return data;
}

// ── GET /payroll-roster/periods ───────────────────────────────────────────────
// Returns all periods with roster_period_status for the current user's placements
router.get('/periods', async (req, res, next) => {
  try {
    const { user } = req;

    let placementIds = [];

    if (user.role === 'placement') {
      const { data: p } = await adminSupabase.from('placements').select('id').eq('user_profile_id', user.id).maybeSingle();
      if (!p) return res.json([]);
      placementIds = [p.id];
    } else if (user.role === 'company_admin' || user.role === 'company_user') {
      const { data: company } = await adminSupabase.from('companies').select('id').eq('carerix_company_id', user.carerix_company_id).maybeSingle();
      if (!company) return res.json([]);
      const { data: plist } = await adminSupabase.from('placements').select('id').eq('company_id', company.id);
      placementIds = (plist || []).map(p => p.id);
    } else {
      // Agency — all placements
      const { data: plist } = await adminSupabase.from('placements').select('id').not('crew_id', 'is', null);
      placementIds = (plist || []).map(p => p.id);
    }

    if (!placementIds.length) return res.json([]);

    // Get all roster_period_status for these placements
    const { data: statuses } = await adminSupabase
      .from('roster_period_status')
      .select('*, placements(id, full_name, crew_id), payroll_periods(id, period_ref, month, year, start_date, end_date, status)')
      .in('placement_id', placementIds)
      .order('created_at', { ascending: false });

    // For placement role, only show contractor_check and beyond
    const filtered = (statuses || []).filter(s => {
      if (user.role === 'placement') return ['contractor_check', 'contractor_correction', 'contractor_approved', 'definite'].includes(s.status);
      if (user.role === 'company_admin' || user.role === 'company_user') return ['client_check', 'contractor_check', 'contractor_correction', 'contractor_approved', 'definite'].includes(s.status);
      return true; // agency sees all
    });

    // Enrich with charge summary
    const enriched = await Promise.all(filtered.map(async s => {
      const { data: charges } = await adminSupabase
        .from('charge_items')
        .select('charge_type_id, quantity, total_value, currency, charge_types(code, label)')
        .eq('placement_id', s.placement_id)
        .eq('period_id', s.period_id);

      const summary = {};
      let totalValue = 0;
      for (const c of charges || []) {
        const code = c.charge_types?.code;
        if (!summary[code]) summary[code] = { code, label: c.charge_types?.label, quantity: 0, totalValue: 0, currency: c.currency };
        summary[code].quantity   += Number(c.quantity || 0);
        summary[code].totalValue += Number(c.total_value || 0);
        totalValue += Number(c.total_value || 0);
      }

      const { data: corrections } = await adminSupabase
        .from('charge_corrections')
        .select('id, status, correction_date, reason, contractor_note, review_note, declined_reason, charge_types(code, label)')
        .eq('placement_id', s.placement_id)
        .eq('period_id', s.period_id);

      return {
        ...s,
        chargeSummary: Object.values(summary),
        totalValue,
        currency: charges?.[0]?.currency || 'USD',
        corrections: corrections || [],
      };
    }));

    res.json(enriched);
  } catch (err) { next(err); }
});

// ── POST /payroll-roster/sync/:periodId ──────────────────────────────────────
// Agency: pull from RAIDO for all placements, set status to draft (or keep existing)
router.post('/sync/:periodId', requireAgency, async (req, res, next) => {
  try {
    const { periodId } = req.params;
    const { data: period } = await adminSupabase.from('payroll_periods').select('*').eq('id', periodId).single();
    if (!period) throw new ApiError('Period not found', 404);

    const { data: placements } = await adminSupabase
      .from('placements').select('id, crew_id, crew_nia, full_name').not('crew_id', 'is', null);

    const today  = new Date().toISOString().split('T')[0];
    const safeTo = period.end_date < today ? period.end_date : today;
    logger.info('Sync: fetching RAIDO', { from: period.start_date, to: safeTo });
    let rosters, allItems;
    try {
      rosters  = await fetchRostersForCrew(period.start_date, safeTo, null);
      allItems = rosterItemsList(rosters);
      logger.info('Sync: RAIDO response', {
        type: Array.isArray(rosters) ? 'array' : typeof rosters,
        itemCount: allItems.length,
        firstItemKeys: allItems[0] ? Object.keys(allItems[0]).slice(0, 8) : [],
        raidoMessage: rosters?.message || null,
      });
    } catch (raidoError) {
      logger.error('Sync: RAIDO fetch failed', { error: raidoError.message });
      return res.status(500).json({ error: 'RAIDO fetch failed: ' + raidoError.message });
    }

    const { data: chargeTypes } = await adminSupabase.from('charge_types').select('id, code');
    const ctByCode = Object.fromEntries((chargeTypes || []).map(ct => [ct.code, ct]));

    let synced = 0;
    for (const placement of placements || []) {
      try {
        const rows       = mapRosterToRows(allItems, placement.crew_id, placement.crew_nia);
        const summaries  = buildDailySummary(rows);
        const crewSummary = summaries.find(c => c.crewId?.toUpperCase() === placement.crew_id?.toUpperCase()) || summaries[0];
        logger.info('Sync: placement mapping', {
          placement: placement.full_name, crew_id: placement.crew_id,
          totalRows: rows.length, summaryCount: summaries.length,
          crewSummaryCrewId: crewSummary?.crewId, days: crewSummary?.days?.length || 0,
        });

        for (const day of crewSummary?.days || []) {
          const activities = (day.activities || []).map(r => ({
            ActivityCode: r.ActivityCode, ActivityType: r.ActivityType,
            ActivitySubType: r.ActivitySubType, start_activity: r.start_activity,
            end_activity: r.end_activity, aBLH: r.aBLH ?? null, Designator: r.Designator,
          }));

          await adminSupabase.from('roster_days').upsert({
            placement_id: placement.id, period_id: periodId, roster_date: day.date,
            crew_id: placement.crew_id, crew_nia: placement.crew_nia,
            activities, is_payable: day.isPayable || false,
            has_ground: day.hasGround || false, has_sim: day.hasSim || false,
            sold_off: day.soldOff || false, bod: day.bod || false,
            fetched_at: new Date().toISOString(),
          }, { onConflict: 'placement_id,period_id,roster_date', returning: 'minimal' });

          for (const [code, qty] of Object.entries(day.charges || {})) {
            if (!qty) continue;
            const ct = ctByCode[code];
            if (!ct) continue;
            await adminSupabase.from('charge_items').upsert({
              placement_id: placement.id, period_id: periodId,
              charge_type_id: ct.id, charge_date: day.date,
              quantity: qty, currency: 'USD', status: 'draft',
            }, { onConflict: 'placement_id,charge_date,charge_type_id', returning: 'minimal' });
          }
        }

        // Create/update roster_period_status — keep existing status if already published
        const existing = await getRosterPeriodStatus(placement.id, periodId);
        if (!existing || existing.status === 'draft') {
          await upsertRosterPeriodStatus(placement.id, periodId, {
            status: 'draft', synced_at: new Date().toISOString(), synced_by: req.user.id,
          });
        }
        synced++;
      } catch (e) {
        logger.error('Sync error', { placement: placement.full_name, error: e.message });
      }
    }

    res.json({ message: 'Sync complete', synced });
  } catch (err) { next(err); }
});

// ── POST /payroll-roster/refresh/:periodId/:placementId ──────────────────────
// Company: refresh RAIDO data for a specific placement (only during client_check)
router.post('/refresh/:periodId/:placementId', requireCompanyOrAbove, async (req, res, next) => {
  try {
    const { periodId, placementId } = req.params;

    const status = await getRosterPeriodStatus(placementId, periodId);
    if (!status || status.status !== 'client_check') throw new ApiError('Can only refresh during client_check status', 400);

    const { data: placement } = await adminSupabase.from('placements').select('id, crew_id, crew_nia, full_name').eq('id', placementId).single();
    if (!placement?.crew_id) throw new ApiError('Placement has no crew_id', 400);

    const { data: period } = await adminSupabase.from('payroll_periods').select('*').eq('id', periodId).single();
    const today  = new Date().toISOString().split('T')[0];
    const safeTo = period.end_date < today ? period.end_date : today;

    const rosters = await fetchRostersForCrew(period.start_date, safeTo, placement.crew_id);
    const items   = rosterItemsList(rosters);
    const rows    = mapRosterToRows(items, placement.crew_id, placement.crew_nia);
    const summaries  = buildDailySummary(rows);
    const crewSummary = summaries.find(c => c.crewId?.toUpperCase() === placement.crew_id?.toUpperCase()) || summaries[0];

    const { data: chargeTypes } = await adminSupabase.from('charge_types').select('id, code');
    const ctByCode = Object.fromEntries((chargeTypes || []).map(ct => [ct.code, ct]));

    for (const day of crewSummary?.days || []) {
      const activities = (day.activities || []).map(r => ({
        ActivityCode: r.ActivityCode, ActivityType: r.ActivityType,
        ActivitySubType: r.ActivitySubType, start_activity: r.start_activity,
        end_activity: r.end_activity, aBLH: r.aBLH ?? null, Designator: r.Designator,
      }));

      await adminSupabase.from('roster_days').upsert({
        placement_id: placementId, period_id: periodId, roster_date: day.date,
        crew_id: placement.crew_id, crew_nia: placement.crew_nia,
        activities, is_payable: day.isPayable || false,
        fetched_at: new Date().toISOString(),
      }, { onConflict: 'placement_id,period_id,roster_date', returning: 'minimal' });

      for (const [code, qty] of Object.entries(day.charges || {})) {
        if (!qty) continue;
        const ct = ctByCode[code];
        if (!ct) continue;
        await adminSupabase.from('charge_items').upsert({
          placement_id: placementId, period_id: periodId,
          charge_type_id: ct.id, charge_date: day.date,
          quantity: qty, currency: 'USD', status: 'draft',
        }, { onConflict: 'placement_id,charge_date,charge_type_id', returning: 'minimal' });
      }
    }

    res.json({ message: 'Refreshed', placement: placement.full_name });
  } catch (err) { next(err); }
});

// ── POST /payroll-roster/publish-to-company ───────────────────────────────────
// Agency: publish draft periods to company (set status to client_check)
router.post('/publish-to-company', requireAgency, async (req, res, next) => {
  try {
    const { periodId, placementIds } = req.body;
    if (!periodId) throw new ApiError('periodId required', 400);

    let ids = placementIds;
    if (!ids?.length) {
      const { data: all } = await adminSupabase.from('placements').select('id').not('crew_id', 'is', null);
      ids = (all || []).map(p => p.id);
    }

    let published = 0;
    for (const pid of ids) {
      const existing = await getRosterPeriodStatus(pid, periodId);
      if (!existing || existing.status === 'draft') {
        await upsertRosterPeriodStatus(pid, periodId, { status: 'client_check', published_at: new Date().toISOString() });
        published++;
      }
    }

    res.json({ message: 'Published to company', published });
  } catch (err) { next(err); }
});

// ── POST /payroll-roster/approve-to-contractor/:placementId/:periodId ─────────
// Company: approve and publish to placement (client_check → contractor_check)
router.post('/approve-to-contractor/:placementId/:periodId', requireCompanyOrAbove, async (req, res, next) => {
  try {
    const { placementId, periodId } = req.params;
    const status = await getRosterPeriodStatus(placementId, periodId);
    if (!status || !['client_check'].includes(status.status)) throw new ApiError('Can only approve from client_check status', 400);
    const updated = await upsertRosterPeriodStatus(placementId, periodId, {
      status: 'contractor_check', approved_by_company_at: new Date().toISOString(),
    });
    res.json(updated);
  } catch (err) { next(err); }
});

// ── POST /payroll-roster/placement-approve/:placementId/:periodId ─────────────
// Placement: approve (contractor_check → contractor_approved)
router.post('/placement-approve/:placementId/:periodId', async (req, res, next) => {
  try {
    const { placementId, periodId } = req.params;
    if (req.user.role === 'placement') {
      const { data: p } = await adminSupabase.from('placements').select('id').eq('user_profile_id', req.user.id).maybeSingle();
      if (!p || p.id !== placementId) throw new ApiError('Access denied', 403);
    }
    const status = await getRosterPeriodStatus(placementId, periodId);
    if (!status || !['contractor_check'].includes(status.status)) throw new ApiError('Can only approve from contractor_check status', 400);
    const updated = await upsertRosterPeriodStatus(placementId, periodId, {
      status: 'contractor_approved', approved_by_placement_at: new Date().toISOString(),
    });
    res.json(updated);
  } catch (err) { next(err); }
});

// ── POST /payroll-roster/placement-correct ────────────────────────────────────
// Placement: request correction (sets status to contractor_correction)
router.post('/placement-correct', async (req, res, next) => {
  try {
    const { placementId, periodId, correctionDate, reason, chargeTypeId } = req.body;
    if (!placementId || !periodId || !correctionDate || !reason) throw new ApiError('placementId, periodId, correctionDate, reason required', 400);

    if (req.user.role === 'placement') {
      const { data: p } = await adminSupabase.from('placements').select('id').eq('user_profile_id', req.user.id).maybeSingle();
      if (!p || p.id !== placementId) throw new ApiError('Access denied', 403);
    }

    const status = await getRosterPeriodStatus(placementId, periodId);
    if (!status || !['contractor_check'].includes(status.status)) throw new ApiError('Can only request corrections during contractor_check', 400);

    const { data: correction, error } = await adminSupabase.from('charge_corrections').insert({
      placement_id: placementId, period_id: periodId, correction_date: correctionDate,
      charge_type_id: chargeTypeId || null, reason, status: 'pending',
      correction_type: 'placement', requested_by: req.user.id,
    }).select().single();
    if (error) throw new ApiError(error.message);

    await upsertRosterPeriodStatus(placementId, periodId, { status: 'contractor_correction' });

    res.status(201).json(correction);
  } catch (err) { next(err); }
});

// ── POST /payroll-roster/resolve-correction/:correctionId ─────────────────────
// Company: approve or decline a correction → sets to definite when all resolved
router.post('/resolve-correction/:correctionId', requireCompanyOrAbove, async (req, res, next) => {
  try {
    const { correctionId } = req.params;
    const { decision, declinedReason } = req.body; // decision: 'approved' | 'declined'
    if (!['approved', 'declined'].includes(decision)) throw new ApiError('decision must be approved or declined', 400);
    if (decision === 'declined' && !declinedReason?.trim()) throw new ApiError('declinedReason required when declining', 400);

    const { data: correction } = await adminSupabase.from('charge_corrections').select('*').eq('id', correctionId).single();
    if (!correction) throw new ApiError('Correction not found', 404);

    await adminSupabase.from('charge_corrections').update({
      status: decision, reviewed_by: req.user.id,
      review_note: declinedReason || null,
      declined_reason: decision === 'declined' ? declinedReason : null,
      updated_at: new Date().toISOString(),
    }).eq('id', correctionId);

    // Check if all corrections for this placement/period are resolved
    const { data: pending } = await adminSupabase
      .from('charge_corrections')
      .select('id')
      .eq('placement_id', correction.placement_id)
      .eq('period_id', correction.period_id)
      .eq('status', 'pending');

    if (!pending?.length) {
      await upsertRosterPeriodStatus(correction.placement_id, correction.period_id, {
        status: 'definite', finalized_at: new Date().toISOString(),
      });
    }

    res.json({ message: `Correction ${decision}`, allResolved: !pending?.length });
  } catch (err) { next(err); }
});

// ── GET /payroll-roster/summary/:placementId/:periodId ────────────────────────
// Get full payroll summary for a placement/period (used by My Payroll expansion)
router.get('/summary/:placementId/:periodId', async (req, res, next) => {
  try {
    const { placementId, periodId } = req.params;

    if (req.user.role === 'placement') {
      const { data: p } = await adminSupabase.from('placements').select('id').eq('user_profile_id', req.user.id).maybeSingle();
      if (!p || p.id !== placementId) throw new ApiError('Access denied', 403);
    }

    const [{ data: chargeItems }, { data: rosterDays }, { data: corrections }, { data: rosterStatus }] = await Promise.all([
      adminSupabase.from('charge_items').select('*, charge_types(code, label, sort_order)').eq('placement_id', placementId).eq('period_id', periodId).order('charge_date'),
      adminSupabase.from('roster_days').select('roster_date, activities, is_payable').eq('placement_id', placementId).eq('period_id', periodId).order('roster_date'),
      adminSupabase.from('charge_corrections').select('*, charge_types(code, label)').eq('placement_id', placementId).eq('period_id', periodId).order('created_at', { ascending: false }),
      adminSupabase.from('roster_period_status').select('*').eq('placement_id', placementId).eq('period_id', periodId).maybeSingle(),
    ]);

    // Build day map
    const rosterMap = Object.fromEntries((rosterDays || []).map(d => [d.roster_date, d]));
    const chargeByDate = {};
    for (const ci of chargeItems || []) {
      if (!chargeByDate[ci.charge_date]) chargeByDate[ci.charge_date] = [];
      chargeByDate[ci.charge_date].push(ci);
    }

    res.json({
      status: rosterStatus,
      chargeItems: chargeItems || [],
      rosterDays: rosterMap,
      chargeByDate,
      corrections: corrections || [],
    });
  } catch (err) { next(err); }
});

export default router;
