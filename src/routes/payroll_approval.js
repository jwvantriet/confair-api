// payroll_approval.js — Company "Payroll Approval" view
import { Router } from 'express';
import { requireAuth, requireCompanyOrAbove } from '../middleware/auth.js';
import { adminSupabase } from '../services/supabase.js';
import { ApiError } from '../middleware/errorHandler.js';
import {
  companyIdsForUser,
  accessRulesForUser,
  filterPlacementsByAccessRules,
  isPlacementActiveInPeriod,
} from '../services/access.js';

const router = Router();
router.use(requireAuth, requireCompanyOrAbove);

// ── GET /payroll-approval/summary/:periodId ────────────────────────────────
router.get('/summary/:periodId', async (req, res, next) => {
  try {
    const { user } = req;
    const { periodId } = req.params;

    // Resolve the period up front — we need its start/end to filter
    // placements by contract-overlap (start_date ≤ period.end AND
    // (end_date is null OR end_date ≥ period.start)).
    const { data: period, error: periodErr } = await adminSupabase
      .from('payroll_periods').select('id, start_date, end_date')
      .eq('id', periodId).maybeSingle();
    if (periodErr) throw new ApiError(periodErr.message);
    if (!period) return res.json({ placements: [] });

    // Agency sees all placements; company sees only their own.
    // Agency may narrow to a single company via ?companyId=<uuid>.
    const isAgency = user.role?.startsWith('agency_');
    const requestedCompanyId = (req.query.companyId || '').trim() || null;

    const requestedFunctionGroup = (req.query.functionGroup || '').trim() || null;
    // Status filter — on by default: only show placements tagged JobActiveTag
    // on the Carerix status node, and whose status itself is still in active
    // use. Opt-out with ?activeOnly=false. Placements with no ingested status
    // (carerix_status_tag IS NULL) are shown regardless — those haven't been
    // touched by a status-aware sync yet, we don't want to hide them blindly.
    const activeOnly = String(req.query.activeOnly ?? 'true').toLowerCase() !== 'false';

    let placementsQuery = adminSupabase
      .from('placements')
      .select('id, crew_id, full_name, qualification, active_roles, crew_group, carerix_function_group, carerix_function_group_id, carerix_status_value, carerix_status_id, carerix_status_tag, carerix_status_active, start_date, end_date, company_id, companies(id, name, carerix_company_id)')
      .order('full_name');

    // Resolve non-agency access rules up front so we can apply both the
    // company scope and the per-company function-group scope.
    const accessRules = !isAgency ? await accessRulesForUser(user) : null;
    if (!isAgency) {
      const companyIds = (accessRules || []).map(r => r.company_id);
      if (!companyIds.length) return res.json({ placements: [] });
      placementsQuery = placementsQuery.in('company_id', companyIds);
    }
    if (requestedCompanyId) {
      placementsQuery = placementsQuery.eq('company_id', requestedCompanyId);
    }
    if (requestedFunctionGroup) {
      placementsQuery = placementsQuery.eq('carerix_function_group', requestedFunctionGroup);
    }

    const { data: rawPlacements, error: pErr } = await placementsQuery;
    if (pErr) throw new ApiError(pErr.message);
    if (!rawPlacements?.length) return res.json({ placements: [] });

    // Access-rule gate: non-agency users may have per-company function-group
    // restrictions (e.g. "only Pilots for AAI 7, all groups for AAI 698").
    const scoped = isAgency
      ? rawPlacements
      : filterPlacementsByAccessRules(rawPlacements, accessRules);

    // Apply view-layer JobActiveTag gate (default on). Rows with a known
    // status must have tag == "JobActiveTag" AND status.active == 1 to be
    // included. Rows with no ingested status (pre-ingestion) are kept so we
    // don't blind-hide legitimate placements until their next sync.
    const statusFiltered = activeOnly
      ? scoped.filter(p => {
          if (p.carerix_status_tag == null && p.carerix_status_id == null) return true;
          return p.carerix_status_tag === 'JobActiveTag' && p.carerix_status_active === 1;
        })
      : scoped;

    // Only keep placements whose contract overlaps this period
    const placements = statusFiltered.filter(p => isPlacementActiveInPeriod(p, period));
    if (!placements.length) return res.json({ placements: [] });

    const placementIds = placements.map(p => p.id);

    // Charge totals per placement for this period
    const { data: charges } = await adminSupabase
      .from('charge_items')
      .select('placement_id, quantity, charge_types(code)')
      .eq('period_id', periodId)
      .in('placement_id', placementIds);

    // Roster period status (sync lock + workflow status)
    const { data: statuses } = await adminSupabase
      .from('roster_period_status')
      .select('placement_id, sync_locked, sync_locked_at, status, approved_by_company_at')
      .eq('period_id', periodId)
      .in('placement_id', placementIds);

    // Fetch approved corrections + roster_days in parallel
    const [{ data: approvedCorrections }, { data: allRosterDays }] = await Promise.all([
      adminSupabase
        .from('charge_corrections')
        .select('placement_id, charge_codes, correction_type')
        .eq('period_id', periodId)
        .eq('status', 'approved')
        .in('placement_id', placementIds),
      adminSupabase
        .from('roster_days')
        .select('placement_id, roster_date, is_payable, activities')
        .eq('period_id', periodId)
        .in('placement_id', placementIds)
        .order('roster_date'),
    ]);

    // Crew corrections store labels (DA/AP/PD), company corrections store codes
    const LABEL_TO_CODE = {
      DA: 'DailyAllowance', AP: 'AvailabilityPremium', YWC: 'YearsWithClient',
      PD: 'PerDiem', HD: 'SoldOffDay', BD: 'BODDays',
    };

    // Compute rotation BLH per placement — find the highest-BLH rotation in the period
    const rotationMap = {};
    const daysByPlacement = {};
    for (const rd of allRosterDays || []) {
      if (!daysByPlacement[rd.placement_id]) daysByPlacement[rd.placement_id] = [];
      daysByPlacement[rd.placement_id].push(rd);
    }
    for (const [pid, days] of Object.entries(daysByPlacement)) {
      let rotStart = null, rotBLH = 0, bestRot = null;
      const hhmmToDec = (h) => { const p = (h||'').split(':'); return p.length===2 ? parseInt(p[0]) + parseInt(p[1])/60 : 0; };
      for (let i = 0; i < days.length; i++) {
        const d = days[i];
        if (d.is_payable) {
          if (!rotStart) rotStart = d.roster_date;
          const acts = Array.isArray(d.activities) ? d.activities : [];
          for (const a of acts) {
            if (a?.aBLH && a.ActivityType?.toUpperCase() === 'FLIGHT') rotBLH += hhmmToDec(a.aBLH);
          }
        } else if (rotStart) {
          const endDate = days[i - 1]?.roster_date || rotStart;
          if (!bestRot || rotBLH > bestRot.blh) bestRot = { blh: Math.round(rotBLH*100)/100, start: rotStart, end: endDate };
          rotStart = null; rotBLH = 0;
        }
      }
      if (rotStart) {
        const endDate = days[days.length-1]?.roster_date || rotStart;
        if (!bestRot || rotBLH > bestRot.blh) bestRot = { blh: Math.round(rotBLH*100)/100, start: rotStart, end: endDate };
      }
      rotationMap[pid] = bestRot;
    }

    // Build charge map: placementId → chargeCode → total quantity
    const chargeMap = {};
    for (const c of charges || []) {
      const code = c.charge_types?.code;
      if (!code) continue;
      if (!chargeMap[c.placement_id]) chargeMap[c.placement_id] = {};
      chargeMap[c.placement_id][code] = (chargeMap[c.placement_id][code] || 0) + Number(c.quantity);
    }

    // Add approved correction charges to totals (map labels → codes for crew corrections)
    for (const corr of approvedCorrections || []) {
      if (!chargeMap[corr.placement_id]) chargeMap[corr.placement_id] = {};
      for (const entry of corr.charge_codes || []) {
        const code = LABEL_TO_CODE[entry] || entry;
        chargeMap[corr.placement_id][code] = (chargeMap[corr.placement_id][code] || 0) + 1;
      }
    }

    // Compute OT per placement (sum of overtime per rotation, > 65h threshold)
    const otMap = {};
    for (const [pid, days] of Object.entries(daysByPlacement)) {
      const hhmmToDec2 = (h) => { const p=(h||'').split(':'); return p.length===2?parseInt(p[0])+parseInt(p[1])/60:0; };
      let totalOT = 0;
      let rotBLH2 = 0;
      let inRot = false;
      for (const d of days) {
        if (d.is_payable) {
          inRot = true;
          const acts = Array.isArray(d.activities) ? d.activities : [];
          for (const a of acts) {
            if (a?.aBLH && a.ActivityType?.toUpperCase() === 'FLIGHT') rotBLH2 += hhmmToDec2(a.aBLH);
          }
        } else if (inRot) {
          if (rotBLH2 > 65) totalOT += Math.round((rotBLH2 - 65) * 100) / 100;
          rotBLH2 = 0; inRot = false;
        }
      }
      if (inRot && rotBLH2 > 65) totalOT += Math.round((rotBLH2 - 65) * 100) / 100;
      otMap[pid] = Math.round(totalOT * 100) / 100;
    }

    // Count pending crew corrections per placement
    const { data: pendingCorrs } = await adminSupabase
      .from('charge_corrections')
      .select('placement_id')
      .eq('period_id', periodId)
      .eq('status', 'pending')
      .neq('correction_type', 'COMPANY')
      .in('placement_id', placementIds);
    const pendingCorrMap = {};
    for (const pc of pendingCorrs || []) {
      pendingCorrMap[pc.placement_id] = (pendingCorrMap[pc.placement_id] || 0) + 1;
    }

    // Build status map
    const statusMap = {};
    for (const s of statuses || []) statusMap[s.placement_id] = s;

    // Build response — field names match the frontend interface
    const result = placements.map(p => ({
      placementId:   p.id,
      crewId:        p.crew_id,
      displayName:   p.full_name,
      qualification: p.qualification,
      active_roles:  p.active_roles,
      crew_group:    p.crew_group,
      functionGroup:    p.carerix_function_group ?? null,
      functionGroupId:  p.carerix_function_group_id ?? null,
      statusValue:      p.carerix_status_value ?? null,
      statusId:         p.carerix_status_id ?? null,
      statusTag:        p.carerix_status_tag ?? null,
      statusActive:     p.carerix_status_active ?? null,
      companyId:             p.company_id,
      companyName:           p.companies?.name ?? null,
      carerixCompanyId:      p.companies?.carerix_company_id ?? null,
      sync_locked:   statusMap[p.id]?.sync_locked || false,
      sync_locked_at: statusMap[p.id]?.sync_locked_at || null,
      status:        statusMap[p.id]?.status || 'draft',
      rotation:      rotationMap[p.id] || null,
      ot:            otMap[p.id] || 0,
      pendingCorrections: pendingCorrMap[p.id] || 0,
      charges: {
        DailyAllowance:      chargeMap[p.id]?.DailyAllowance      || 0,
        AvailabilityPremium: chargeMap[p.id]?.AvailabilityPremium || 0,
        YearsWithClient:     chargeMap[p.id]?.YearsWithClient     || 0,
        PerDiem:             chargeMap[p.id]?.PerDiem             || 0,
        SoldOffDay:          chargeMap[p.id]?.SoldOffDay          || 0,
        BODDays:             chargeMap[p.id]?.BODDays             || 0,
        Overtime:            chargeMap[p.id]?.Overtime            || 0,
      },
    }));

    res.json({ placements: result });
  } catch (err) { next(err); }
});

// ── GET /payroll-approval/roster/:placementId/:periodId ────────────────────
router.get('/roster/:placementId/:periodId', async (req, res, next) => {
  try {
    const { user } = req;
    const { placementId, periodId } = req.params;

    // Agency can access any placement; company can only access their own
    if (!user.role?.startsWith('agency_')) {
      const companyIds = await companyIdsForUser(user);
      if (!companyIds?.length) throw new ApiError('Placement not found or access denied', 404);
      const { data: placement } = await adminSupabase
        .from('placements').select('id')
        .eq('id', placementId)
        .in('company_id', companyIds)
        .maybeSingle();
      if (!placement) throw new ApiError('Placement not found or access denied', 404);
    }

    // Roster days with activities
    const { data: rosterDays } = await adminSupabase
      .from('roster_days')
      .select('roster_date, activities, is_payable')
      .eq('placement_id', placementId)
      .eq('period_id', periodId)
      .order('roster_date');

    // Charge items for this placement/period
    const { data: chargeItems } = await adminSupabase
      .from('charge_items')
      .select('charge_date, quantity, rate_per_unit, currency, charge_types(code)')
      .eq('placement_id', placementId)
      .eq('period_id', periodId);

    // All corrections for this placement/period (crew + company)
    const { data: corrections } = await adminSupabase
      .from('charge_corrections')
      .select('id, correction_date, status, correction_type, charge_codes, blh_hhmm, reason, created_at')
      .eq('placement_id', placementId)
      .eq('period_id', periodId)
      .order('correction_date');

    res.json({
      rosterDays:  rosterDays  || [],
      chargeItems: chargeItems || [],
      corrections: corrections || [],
    });
  } catch (err) { next(err); }
});

// ── POST /payroll-approval/correction ─────────────────────────────────────
router.post('/correction', async (req, res, next) => {
  try {
    const { user } = req;
    const { placement_id, period_id, correction_date, charge_codes, blh_hhmm, reason } = req.body;

    if (!placement_id || !period_id || !correction_date)
      throw new ApiError('placement_id, period_id and correction_date are required', 400);

    // Verify ownership — placement must be in one of the user's companies
    const companyIds = await companyIdsForUser(user);
    if (!companyIds?.length) throw new ApiError('Placement not found or access denied', 404);
    const { data: placement } = await adminSupabase
      .from('placements').select('id')
      .eq('id', placement_id)
      .in('company_id', companyIds)
      .maybeSingle();
    if (!placement) throw new ApiError('Placement not found or access denied', 404);

    // BLH decimal conversion
    let blh_decimal = null;
    if (blh_hhmm) {
      const parts = blh_hhmm.split(':');
      if (parts.length === 2) blh_decimal = Math.round((parseInt(parts[0]) + parseInt(parts[1]) / 60) * 100) / 100;
    }

    // Insert correction — immediately approved
    const { data: correction, error } = await adminSupabase
      .from('charge_corrections')
      .insert({
        placement_id,
        period_id,
        correction_date,
        correction_type: 'COMPANY',
        charge_codes:    charge_codes || [],
        blh_hhmm:        blh_hhmm || null,
        blh_decimal,
        reason:          reason || 'Company correction',
        status:          'approved',
        is_rotation_end_correction: false,
      })
      .select()
      .single();
    if (error) throw new ApiError(error.message);

    // Lock sync for this placement/period
    await adminSupabase
      .from('roster_period_status')
      .upsert({
        placement_id,
        period_id,
        sync_locked:    true,
        sync_locked_at: new Date().toISOString(),
        sync_locked_by: user.id,
        updated_at:     new Date().toISOString(),
      }, { onConflict: 'placement_id,period_id' });

    res.json({ correction });
  } catch (err) { next(err); }
});

// ── POST /payroll-approval/approve-line/:placementId/:periodId ────────────────
// Company approves a placement line: client_check → contractor_check
router.post('/approve-line/:placementId/:periodId', async (req, res, next) => {
  try {
    const { user } = req;
    const { placementId, periodId } = req.params;

    // Verify placement belongs to this company (or agency can approve any)
    if (!user.role?.startsWith('agency_')) {
      const companyIds = await companyIdsForUser(user);
      if (!companyIds?.length) throw new ApiError('Forbidden', 403);
      const { data: placement } = await adminSupabase
        .from('placements').select('id').eq('id', placementId).in('company_id', companyIds).maybeSingle();
      if (!placement) throw new ApiError('Forbidden', 403);
    }

    const { data: existing } = await adminSupabase
      .from('roster_period_status')
      .select('status')
      .eq('placement_id', placementId)
      .eq('period_id', periodId)
      .maybeSingle();

    if (!existing) {
      // Create the status record as contractor_check
      await adminSupabase.from('roster_period_status').insert({
        placement_id: placementId, period_id: periodId,
        status: 'contractor_check',
        approved_by_company_at: new Date().toISOString(),
      });
    } else if (existing.status === 'client_check' || existing.status === 'draft') {
      await adminSupabase.from('roster_period_status').update({
        status: 'contractor_check',
        approved_by_company_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('placement_id', placementId).eq('period_id', periodId);
    } else {
      throw new ApiError(`Cannot approve from status: ${existing.status}`, 400);
    }

    res.json({ approved: true, placementId, periodId, newStatus: 'contractor_check' });
  } catch (err) { next(err); }
});

// ── POST /payroll-approval/approve-correction/:id ─────────────────────────
// Company approves a pending crew correction → sets status approved, locks sync
router.post('/approve-correction/:id', async (req, res, next) => {
  try {
    const { user } = req;

    const { data: correction, error: fetchErr } = await adminSupabase
      .from('charge_corrections')
      .select('id, status, correction_type, placement_id, period_id')
      .eq('id', req.params.id)
      .single();
    if (fetchErr || !correction) throw new ApiError('Correction not found', 404);
    if (correction.correction_type === 'COMPANY') throw new ApiError('Cannot approve company corrections this way', 400);

    // Verify placement belongs to one of the user's companies
    {
      const companyIds = await companyIdsForUser(user);
      if (!companyIds?.length) throw new ApiError('Forbidden', 403);
      const { data: placement } = await adminSupabase
        .from('placements').select('id').eq('id', correction.placement_id).in('company_id', companyIds).maybeSingle();
      if (!placement) throw new ApiError('Forbidden', 403);
    }

    // Approve
    const { error } = await adminSupabase
      .from('charge_corrections')
      .update({ status: 'approved', reviewed_by: user.id })
      .eq('id', req.params.id);
    if (error) throw new ApiError(error.message);

    // Lock sync
    await adminSupabase.from('roster_period_status').upsert({
      placement_id: correction.placement_id,
      period_id: correction.period_id,
      sync_locked: true,
      sync_locked_at: new Date().toISOString(),
      sync_locked_by: user.id,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'placement_id,period_id' });

    // Auto-transition to definite if no more pending crew corrections remain
    const { data: stillPending } = await adminSupabase
      .from('charge_corrections').select('id')
      .eq('placement_id', correction.placement_id).eq('period_id', correction.period_id)
      .eq('status', 'pending').neq('correction_type', 'COMPANY').limit(1);
    if (!stillPending?.length) {
      await adminSupabase.from('roster_period_status')
        .update({ status: 'definite', finalized_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('placement_id', correction.placement_id).eq('period_id', correction.period_id)
        .in('status', ['contractor_correction']);
    }

    res.json({ approved: true, id: req.params.id });
  } catch (err) { next(err); }
});

// ── POST /payroll-approval/decline-correction/:id ─────────────────────────
router.post('/decline-correction/:id', async (req, res, next) => {
  try {
    const { user } = req;
    const { reason } = req.body;

    const { data: correction, error: fetchErr } = await adminSupabase
      .from('charge_corrections')
      .select('id, status, correction_type, placement_id, period_id')
      .eq('id', req.params.id)
      .single();
    if (fetchErr || !correction) throw new ApiError('Correction not found', 404);
    if (correction.correction_type === 'COMPANY') throw new ApiError('Cannot decline company corrections', 400);
    if (correction.status !== 'pending') throw new ApiError('Only pending corrections can be declined', 400);

    // Verify placement belongs to one of the user's companies
    {
      const companyIds = await companyIdsForUser(user);
      if (!companyIds?.length) throw new ApiError('Forbidden', 403);
      const { data: placement } = await adminSupabase
        .from('placements').select('id').eq('id', correction.placement_id).in('company_id', companyIds).maybeSingle();
      if (!placement) throw new ApiError('Forbidden', 403);
    }

    const { error } = await adminSupabase
      .from('charge_corrections')
      .update({ status: 'declined', reviewed_by: user.id, declined_reason: reason || null })
      .eq('id', req.params.id);
    if (error) throw new ApiError(error.message);

    // Auto-transition to definite if no more pending crew corrections remain
    const { data: stillPendingD } = await adminSupabase
      .from('charge_corrections').select('id')
      .eq('placement_id', correction.placement_id).eq('period_id', correction.period_id)
      .eq('status', 'pending').neq('correction_type', 'COMPANY').limit(1);
    if (!stillPendingD?.length) {
      await adminSupabase.from('roster_period_status')
        .update({ status: 'definite', finalized_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('placement_id', correction.placement_id).eq('period_id', correction.period_id)
        .in('status', ['contractor_correction']);
    }

    res.json({ declined: true, id: req.params.id });
  } catch (err) { next(err); }
});

// ── POST /payroll-approval/reset-status/:placementId/:periodId ────────────
// Agency only: move a placement to any status without touching sync_locked
router.post('/reset-status/:placementId/:periodId', async (req, res, next) => {
  try {
    const { user } = req;
    if (!user.role?.startsWith('agency_')) throw new ApiError('Agency only', 403);

    const { placementId, periodId } = req.params;
    const { status } = req.body;
    const VALID = ['draft','client_check','contractor_check','contractor_correction','definite','contractor_approved'];
    if (!VALID.includes(status)) throw new ApiError('Invalid status', 400);

    // Check if record exists
    const { data: existing } = await adminSupabase
      .from('roster_period_status').select('id')
      .eq('placement_id', placementId).eq('period_id', periodId).maybeSingle();

    if (existing) {
      // Update ONLY status — leave sync_locked, sync_locked_at, sync_locked_by untouched
      await adminSupabase.from('roster_period_status')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('placement_id', placementId).eq('period_id', periodId);
    } else {
      await adminSupabase.from('roster_period_status')
        .insert({ placement_id: placementId, period_id: periodId, status });
    }

    res.json({ reset: true, status, placementId, periodId });
  } catch (err) { next(err); }
});

export default router;
