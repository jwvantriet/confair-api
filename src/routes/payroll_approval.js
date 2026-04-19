// payroll_approval.js — Company "Payroll Approval" view
// GET /payroll-approval/summary/:periodId   → all placements for the company with charge totals
// GET /payroll-approval/roster/:placementId/:periodId → day-by-day roster for one placement
// POST /payroll-approval/correction         → company adds a correction (auto-approved, locks sync)

import { Router } from 'express';
import { requireAuth, requireCompanyOrAbove } from '../middleware/auth.js';
import { adminSupabase } from '../services/supabase.js';
import { ApiError } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth, requireCompanyOrAbove);

// ── GET /payroll-approval/summary/:periodId ────────────────────────────────────
router.get('/summary/:periodId', async (req, res, next) => {
  try {
    const { user } = req;
    const { periodId } = req.params;

    // Resolve company
    const { data: company } = await adminSupabase
      .from('companies').select('id').eq('carerix_company_id', user.carerix_company_id).maybeSingle();
    if (!company) throw new ApiError('Company not found', 404);

    // All active placements for this company
    const { data: placements, error: pErr } = await adminSupabase
      .from('placements')
      .select('id, crew_id, full_name, qualification, active_roles, crew_group')
      .eq('company_id', company.id)
      .eq('is_active', true)
      .order('full_name');
    if (pErr) throw new ApiError(pErr.message);
    if (!placements?.length) return res.json({ placements: [] });

    const placementIds = placements.map(p => p.id);

    // Charge totals per placement for this period
    const { data: charges } = await adminSupabase
      .from('charge_items')
      .select('placement_id, quantity, charge_types(code)')
      .eq('period_id', periodId)
      .in('placement_id', placementIds);

    // Roster period status (sync_locked, rotation dates)
    const { data: statuses } = await adminSupabase
      .from('roster_period_status')
      .select('placement_id, sync_locked, sync_locked_at, status')
      .eq('period_id', periodId)
      .in('placement_id', placementIds);

    // Rotation start/end from roster_days
    const { data: rotationBounds } = await adminSupabase.rpc('get_rotation_bounds', {
      p_period_id:     periodId,
      p_placement_ids: placementIds,
    }).catch(() => ({ data: null }));

    // Total BLH from roster_days activities
    const { data: rosterDays } = await adminSupabase
      .from('roster_days')
      .select('placement_id, activities')
      .eq('period_id', periodId)
      .in('placement_id', placementIds);

    // Build lookup maps
    const chargeMap  = {};
    const statusMap  = {};
    const boundsMap  = {};
    const blhMap     = {};

    for (const c of charges || []) {
      if (!chargeMap[c.placement_id]) chargeMap[c.placement_id] = {};
      const code = c.charge_types?.code;
      if (code) chargeMap[c.placement_id][code] = (chargeMap[c.placement_id][code] || 0) + Number(c.quantity);
    }
    for (const s of statuses || []) statusMap[s.placement_id] = s;

    if (Array.isArray(rotationBounds)) {
      for (const b of rotationBounds) boundsMap[b.placement_id] = b;
    }

    // Compute total BLH per placement from activities JSON
    for (const day of rosterDays || []) {
      const acts = day.activities || [];
      let blh = 0;
      for (const a of acts) {
        if (a?.ActivityType?.toUpperCase() === 'FLIGHT' && a.aBLH) {
          const parts = String(a.aBLH).split(':');
          if (parts.length === 2) blh += parseInt(parts[0]) + parseInt(parts[1]) / 60;
        }
      }
      blhMap[day.placement_id] = (blhMap[day.placement_id] || 0) + blh;
    }

    const result = placements.map(p => ({
      id:           p.id,
      crew_id:      p.crew_id,
      full_name:    p.full_name,
      qualification: p.qualification,
      active_roles:  p.active_roles,
      crew_group:    p.crew_group,
      sync_locked:   statusMap[p.id]?.sync_locked || false,
      sync_locked_at: statusMap[p.id]?.sync_locked_at || null,
      status:        statusMap[p.id]?.status || null,
      total_blh:     Math.round((blhMap[p.id] || 0) * 100) / 100,
      start_period:  boundsMap[p.id]?.start_period || null,
      end_period:    boundsMap[p.id]?.end_period   || null,
      charges: {
        DailyAllowance:      chargeMap[p.id]?.DailyAllowance      || 0,
        AvailabilityPremium: chargeMap[p.id]?.AvailabilityPremium || 0,
        YearsWithClient:     chargeMap[p.id]?.YearsWithClient     || 0,
        PerDiem:             chargeMap[p.id]?.PerDiem             || 0,
        SoldOffDay:          chargeMap[p.id]?.SoldOffDay          || 0,
        BODDays:             chargeMap[p.id]?.BODDays             || 0,
      },
    }));

    res.json({ placements: result });
  } catch (err) { next(err); }
});

// ── GET /payroll-approval/roster/:placementId/:periodId ───────────────────────
router.get('/roster/:placementId/:periodId', async (req, res, next) => {
  try {
    const { user } = req;
    const { placementId, periodId } = req.params;

    // Verify this placement belongs to the user's company
    const { data: company } = await adminSupabase
      .from('companies').select('id').eq('carerix_company_id', user.carerix_company_id).maybeSingle();
    if (!company) throw new ApiError('Company not found', 404);

    const { data: placement } = await adminSupabase
      .from('placements').select('id, crew_id, full_name, crew_nia')
      .eq('id', placementId).eq('company_id', company.id).maybeSingle();
    if (!placement) throw new ApiError('Placement not found or access denied', 404);

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

    // Company corrections for this placement/period
    const { data: corrections } = await adminSupabase
      .from('charge_corrections')
      .select('id, correction_date, status, charge_codes, blh_hhmm, reason, attachment_url, created_at')
      .eq('placement_id', placementId)
      .eq('period_id', periodId)
      .order('correction_date');

    res.json({ rosterDays: rosterDays || [], chargeItems: chargeItems || [], corrections: corrections || [] });
  } catch (err) { next(err); }
});

// ── POST /payroll-approval/correction ─────────────────────────────────────────
// Company submits a correction → immediately 'approved', locks sync for this placement/period
router.post('/correction', async (req, res, next) => {
  try {
    const { user } = req;
    const { placement_id, period_id, correction_date, charge_codes, blh_hhmm, reason, attachment_url, attachment_name } = req.body;

    if (!placement_id || !period_id || !correction_date) {
      throw new ApiError('placement_id, period_id and correction_date are required', 400);
    }

    // Verify ownership
    const { data: company } = await adminSupabase
      .from('companies').select('id').eq('carerix_company_id', user.carerix_company_id).maybeSingle();
    if (!company) throw new ApiError('Company not found', 404);

    const { data: placement } = await adminSupabase
      .from('placements').select('id').eq('id', placement_id).eq('company_id', company.id).maybeSingle();
    if (!placement) throw new ApiError('Placement not found or access denied', 404);

    // Insert correction — status is immediately 'approved'
    const { data: correction, error } = await adminSupabase
      .from('charge_corrections')
      .insert({
        placement_id,
        period_id,
        correction_date,
        correction_type: 'COMPANY',
        charge_codes:    charge_codes || [],
        blh_hhmm:        blh_hhmm || null,
        blh_decimal:     blh_hhmm ? (() => { const p = blh_hhmm.split(':'); return Math.round((parseInt(p[0]) + parseInt(p[1]||0)/60)*100)/100; })() : null,
        reason:          reason || 'Company correction',
        status:          'approved',
        attachment_url:  attachment_url || null,
        attachment_name: attachment_name || null,
        is_rotation_end_correction: false,
      })
      .select()
      .single();
    if (error) throw new ApiError(error.message);

    // Lock sync for this placement/period
    await adminSupabase
      .from('roster_period_status')
      .upsert({
        placement_id, period_id,
        sync_locked:    true,
        sync_locked_at: new Date().toISOString(),
        sync_locked_by: user.id,
        updated_at:     new Date().toISOString(),
      }, { onConflict: 'placement_id,period_id' });

    res.json({ correction });
  } catch (err) { next(err); }
});

export default router;
