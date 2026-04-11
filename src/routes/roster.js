/**
 * Roster routes
 *
 * POST /roster/sync/:periodId          — Fetch RAIDO rosters + compute charge items (Agency)
 * GET  /roster/summary/:periodId       — Period summary per placement (all roles)
 * GET  /roster/daily/:periodId/:placementId — Daily breakdown (placement + company + agency)
 * POST /roster/correction              — Request a correction (placement)
 * GET  /roster/corrections/:periodId   — List corrections (agency + company)
 * PATCH /roster/correction/:id         — Approve/reject correction (company + agency)
 */
import { Router } from 'express';
import { adminSupabase } from '../services/supabase.js';
import { requireAuth, requireAgency, requireCompanyOrAbove } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import {
  fetchRostersForCrew, rosterItemsList, mapRosterToRows,
  buildDailySummary, dayIsPayable, monthBounds,
} from '../services/raido.js';
// queryGraphQL imported lazily to avoid startup crash if not yet exported
let _queryGraphQL = null;
async function getQueryGraphQL() {
  if (_queryGraphQL) return _queryGraphQL;
  try {
    const mod = await import('../services/carerix.js');
    _queryGraphQL = mod.queryGraphQL || mod.default?.queryGraphQL;
  } catch (e) {
    console.warn('queryGraphQL not available:', e.message);
  }
  return _queryGraphQL;
}

const router = Router();
router.use(requireAuth);

// ── Charge type ID lookup ─────────────────────────────────────────────────────
const CHARGE_TYPE_MAP = {
  DailyAllowance:     9582,
  AvailabilityPremium: 12308,
  YearsWithClient:    12328,
  PerDiem:            10203,
  GroundFee:          11382,
  SimFee:             10217,
  SoldOffDay:         10062,
  BODDays:            12378,
};

// ── Rate lookup from Carerix Finance ─────────────────────────────────────────
async function fetchRatesForPlacement(jobId) {
  if (!jobId) return [];
  try {
    const qGraphQL = await getQueryGraphQL();
    if (!qGraphQL) { logger.warn('queryGraphQL not available, skipping rate fetch'); return []; }
    const data = await qGraphQL(`
      query JobFinancePage($qualifier: String, $pageable: Pageable) {
        crJobFinancePage(qualifier: $qualifier, pageable: $pageable) {
          items {
            _id
            toFinance {
              _id
              startDate
              endDate
              amount
              toTypeNode { typeID identifier }
              toCurrencyNode { dataNodeID value }
            }
          }
        }
      }
    `, { qualifier: `toJob.jobID == ${jobId}`, pageable: { page: 0, size: 200 } });

    const items = data?.data?.crJobFinancePage?.items || [];
    return items
      .map(i => i.toFinance)
      .filter(f => f && f.amount != null && f.toTypeNode?.typeID);
  } catch (e) {
    logger.warn('Rate fetch failed', { jobId, error: e.message });
    return [];
  }
}

// Find applicable rate for a charge type on a given date
function findApplicableRate(rates, carerixTypeId, date) {
  return rates.find(r => {
    if (r.toTypeNode?.typeID !== carerixTypeId) return false;
    const from = r.startDate ? new Date(r.startDate) : null;
    const to   = r.endDate   ? new Date(r.endDate)   : null;
    const d    = new Date(date);
    if (from && d < from) return false;
    if (to   && d > to)   return false;
    return true;
  });
}

// ── GET charge_types ──────────────────────────────────────────────────────────
router.get('/charge-types', async (req, res, next) => {
  try {
    const { data } = await adminSupabase.from('charge_types').select('*').order('sort_order');
    res.json(data);
  } catch (err) { next(err); }
});

// ── POST /roster/sync/:periodId ───────────────────────────────────────────────
router.post('/sync/:periodId', requireAgency, async (req, res, next) => {
  try {
    const { periodId } = req.params;

    // Get the period
    const { data: period, error: pErr } = await adminSupabase
      .from('payroll_periods').select('*').eq('id', periodId).single();
    if (pErr || !period) throw new ApiError('Period not found', 404);

    // Get all placements with crew_id set
    const { data: placements } = await adminSupabase
      .from('placements')
      .select('id, placement_ref, full_name, crew_id, crew_nia, carerix_placement_id, user_profile_id')
      .not('crew_id', 'is', null);

    if (!placements?.length) {
      return res.json({ message: 'No placements with crew_id configured', synced: 0 });
    }

    const periodFrom = period.start_date;
    const periodTo   = period.end_date;

    let synced = 0, errors = 0;
    const results = [];

    for (const placement of placements) {
      try {
        // Fetch RAIDO roster for this crew
        const rosters    = await fetchRostersForCrew(periodFrom, periodTo, placement.crew_id);
        const items      = rosterItemsList(rosters);
        logger.info('RAIDO response', {
          crew_id:     placement.crew_id,
          itemCount:   items.length,
          firstKeys:   items[0] ? Object.keys(items[0]).slice(0, 10) : [],
          firstItem:   JSON.stringify(items[0] || {}).substring(0, 300),
        });
        const rows       = mapRosterToRows(items, placement.crew_id, placement.crew_nia);
        logger.info('Mapped rows', { count: rows.length, firstRow: rows[0] ? JSON.stringify(rows[0]).substring(0, 200) : 'none' });
        const summary    = buildDailySummary(rows);
        const crewSummary = summary.find(c => c.crewId === placement.crew_id) || { days: [], totals: {} };

        // Fetch rates from Carerix Finance
        const rates = placement.carerix_placement_id
          ? await fetchRatesForPlacement(placement.carerix_placement_id)
          : [];

        // Upsert roster_days and charge_items
        let itemsCreated = 0;
        for (const day of crewSummary.days) {
          // Upsert roster_day
          const { data: rosterDay } = await adminSupabase
            .from('roster_days')
            .upsert({
              placement_id: placement.id,
              period_id:    periodId,
              roster_date:  day.date,
              crew_id:      placement.crew_id,
              crew_nia:     placement.crew_nia,
              activities:   day.activities,
              is_payable:   day.isPayable,
              has_ground:   day.hasGround,
              has_sim:      day.hasSim,
              has_pxp:      day.hasPxp,
              sold_off:     day.soldOff,
              bod:          day.bod,
              fetched_at:   new Date().toISOString(),
            }, { onConflict: 'placement_id,roster_date', returning: 'minimal' });

          // Create charge items for each charge type on this day
          for (const [chargeCode, qty] of Object.entries(day.charges || {})) {
            if (!qty) continue;
            const carerixTypeId = CHARGE_TYPE_MAP[chargeCode];
            if (!carerixTypeId) continue;

            // Get charge_type id
            const { data: ct } = await adminSupabase
              .from('charge_types').select('id').eq('carerix_type_id', carerixTypeId).single();
            if (!ct) continue;

            // Find applicable rate
            const rate = findApplicableRate(rates, carerixTypeId, day.date);
            const rateAmount = rate?.amount || null;
            const currency   = rate?.toCurrencyNode?.value || 'USD';

            await adminSupabase.from('charge_items').upsert({
              placement_id:   placement.id,
              period_id:      periodId,
              charge_type_id: ct.id,
              charge_date:    day.date,
              quantity:       qty,
              rate_amount:    rateAmount,
              currency,
              total_value:    rateAmount ? qty * rateAmount : null,
              status:         'confirmed',
            }, { onConflict: 'placement_id,charge_date,charge_type_id', returning: 'minimal' });
            itemsCreated++;
          }
        }

        results.push({ placement: placement.full_name, days: crewSummary.days.length, items: itemsCreated });
        synced++;
      } catch (e) {
        logger.error('Sync failed for placement', { placement: placement.full_name, error: e.message });
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
    const { user } = req;

    let query = adminSupabase
      .from('charge_items')
      .select(`
        placement_id,
        charge_type_id,
        charge_date,
        quantity,
        rate_amount,
        currency,
        total_value,
        status,
        charge_types ( code, label, sort_order ),
        placements ( id, full_name, crew_id, company_id )
      `)
      .eq('period_id', periodId)
      .order('charge_date');

    // Filter by role
    if (user.role === 'placement') {
      // Find their placement record
      const { data: placement } = await adminSupabase
        .from('placements').select('id').eq('user_profile_id', user.id).maybeSingle();
      if (!placement) return res.json({ placements: [] });
      query = query.eq('placement_id', placement.id);
    } else if (user.role === 'company_admin') {
      const { data: company } = await adminSupabase
        .from('companies').select('id').eq('carerix_company_id', user.carerix_company_id).maybeSingle();
      if (!company) return res.json({ placements: [] });
      query = query.eq('placements.company_id', company.id);
    }

    const { data: items, error } = await query;
    if (error) throw new ApiError(error.message);

    // Group by placement → charge type → totals
    const byPlacement = new Map();
    for (const item of items || []) {
      const pid = item.placement_id;
      if (!byPlacement.has(pid)) {
        byPlacement.set(pid, {
          placementId:   pid,
          displayName:   item.placements?.full_name || '',
          chargeTypes:   new Map(),
          totalValue:    0,
          currency:      item.currency,
        });
      }
      const p    = byPlacement.get(pid);
      const code = item.charge_types?.code;
      if (!p.chargeTypes.has(code)) {
        p.chargeTypes.set(code, { code, label: item.charge_types?.label, quantity: 0, totalValue: 0, currency: item.currency });
      }
      const ct = p.chargeTypes.get(code);
      ct.quantity   += Number(item.quantity   || 0);
      ct.totalValue += Number(item.total_value || 0);
      p.totalValue  += Number(item.total_value || 0);
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

    // Access control
    if (req.user.role === 'placement') {
      const { data: p } = await adminSupabase
        .from('placements').select('id').eq('user_profile_id', req.user.id).maybeSingle();
      if (!p || p.id !== placementId) throw new ApiError('Access denied', 403);
    }

    const { data: items, error } = await adminSupabase
      .from('charge_items')
      .select(`*, charge_types ( code, label, sort_order )`)
      .eq('period_id', periodId)
      .eq('placement_id', placementId)
      .order('charge_date')
      .order('charge_types(sort_order)');

    if (error) throw new ApiError(error.message);

    // Get corrections for this period/placement
    const { data: corrections } = await adminSupabase
      .from('charge_corrections')
      .select(`*, charge_types ( code, label )`)
      .eq('period_id', periodId)
      .eq('placement_id', placementId);

    // Group by date
    const byDate = new Map();
    for (const item of items || []) {
      if (!byDate.has(item.charge_date)) byDate.set(item.charge_date, { date: item.charge_date, charges: [], totalValue: 0 });
      const d = byDate.get(item.charge_date);
      d.charges.push(item);
      d.totalValue += Number(item.total_value || 0);
    }

    res.json({
      days: Array.from(byDate.values()),
      corrections: corrections || [],
    });
  } catch (err) { next(err); }
});

// ── POST /roster/correction ───────────────────────────────────────────────────
router.post('/correction', async (req, res, next) => {
  try {
    const { periodId, correctionDate, chargeTypeId, reason } = req.body;
    if (!periodId || !correctionDate || !reason) throw new ApiError('periodId, correctionDate and reason are required', 400);

    // Get placement for this user
    const { data: placement } = await adminSupabase
      .from('placements').select('id').eq('user_profile_id', req.user.id).maybeSingle();
    if (!placement) throw new ApiError('No placement found for this user', 404);

    const { data, error } = await adminSupabase.from('charge_corrections').insert({
      placement_id:    placement.id,
      period_id:       periodId,
      correction_date: correctionDate,
      charge_type_id:  chargeTypeId || null,
      reason,
      status:          'pending',
      requested_by:    req.user.id,
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
      .select(`*, charge_types ( code, label ), placements ( display_name )`)
      .eq('period_id', req.params.periodId)
      .order('created_at', { ascending: false });
    if (error) throw new ApiError(error.message);
    res.json(data);
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
      .eq('id', req.params.id)
      .select().single();

    if (error) throw new ApiError(error.message);
    res.json(data);
  } catch (err) { next(err); }
});

export default router;
