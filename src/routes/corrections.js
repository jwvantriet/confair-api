/**
 * Corrections routes
 *
 * GET  /corrections                    — List corrections visible to current user
 * POST /corrections                    — Placement creates a correction request
 * POST /corrections/:id/approve        — Company/Agency approves (auto-adds to run)
 * POST /corrections/:id/decline        — Company/Agency declines (reason mandatory)
 */

import { Router } from 'express';
import { requireAuth, requireCompanyOrAbove } from '../middleware/auth.js';
import { adminSupabase } from '../services/supabase.js';
import { companyIdsForUser } from '../services/access.js';
import { ApiError } from '../middleware/errorHandler.js';
import { writeAuditLog } from '../utils/audit.js';
import { logger } from '../utils/logger.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const { status } = req.query;
    let query = req.supabase
      .from('correction_requests')
      .select(`
        *, declaration_types(code,label), placements(full_name),
        companies(name), payroll_periods(period_ref)
      `)
      .order('created_at', { ascending: false });
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw new ApiError(error.message);
    res.json(data);
  } catch (err) { next(err); }
});

// Old correction_requests POST removed — replaced by charge_corrections below

router.post('/:id/approve', requireCompanyOrAbove, async (req, res, next) => {
  try {
    const { data: corr, error } = await adminSupabase
      .from('correction_requests')
      .select('*, payroll_periods(id)')
      .eq('id', req.params.id)
      .single();
    if (error || !corr) throw new ApiError('Correction not found', 404);
    if (corr.status !== 'requested') throw new ApiError('Correction is not in requested status');

    // Find or create the active run for this period
    let { data: run } = await adminSupabase
      .from('payroll_runs')
      .select('id')
      .eq('payroll_period_id', corr.payroll_period_id)
      .not('status', 'eq', 'finalized')
      .maybeSingle();

    if (!run) {
      const { data: newRun } = await adminSupabase
        .from('payroll_runs')
        .insert({ payroll_period_id: corr.payroll_period_id, status: 'in_progress' })
        .select()
        .single();
      run = newRun;
    }

    // Add to run
    await adminSupabase.from('payroll_run_entries').insert({
      payroll_run_id:       run.id,
      correction_request_id: corr.id,
      amount:               corr.requested_amount,
    });

    // Update correction
    await adminSupabase.from('correction_requests').update({
      status:          'approved',
      reviewed_by:     req.user.id,
      reviewed_at:     new Date().toISOString(),
      included_in_run: true,
      payroll_run_id:  run.id,
    }).eq('id', corr.id);

    await adminSupabase.from('approval_actions').insert({
      entity_type: 'correction_request', entity_id: corr.id,
      stage: 'company_initial', action: 'approved',
      actor_user_id: req.user.id, actor_role: req.user.role,
    });

    await writeAuditLog({ eventType: 'correction_approved', actorUserId: req.user.id, actorRole: req.user.role, entityType: 'correction_request', entityId: corr.id });
    res.json({ message: 'Correction approved and added to run', runId: run.id });
  } catch (err) { next(err); }
});

router.post('/:id/decline', requireCompanyOrAbove, async (req, res, next) => {
  try {
    const { declineReason } = req.body;
    if (!declineReason?.trim()) throw new ApiError('declineReason is mandatory', 400);

    const { data: corr, error } = await adminSupabase
      .from('correction_requests').select('id, status').eq('id', req.params.id).single();
    if (error || !corr) throw new ApiError('Correction not found', 404);
    if (corr.status !== 'requested') throw new ApiError('Correction is not in requested status');

    await adminSupabase.from('correction_requests').update({
      status: 'declined', decline_reason: declineReason,
      reviewed_by: req.user.id, reviewed_at: new Date().toISOString(),
    }).eq('id', corr.id);

    await adminSupabase.from('approval_actions').insert({
      entity_type: 'correction_request', entity_id: corr.id,
      stage: 'company_initial', action: 'declined',
      actor_user_id: req.user.id, actor_role: req.user.role,
      decline_reason: declineReason,
    });

    await writeAuditLog({ eventType: 'correction_declined', actorUserId: req.user.id, actorRole: req.user.role, entityType: 'correction_request', entityId: corr.id, payload: { declineReason } });
    res.json({ message: 'Correction declined' });
  } catch (err) { next(err); }
});


// Attachments bucket should be configured as PRIVATE in Supabase.
// Signed URLs give per-access control; the bucket must not be public or the
// signature adds nothing. TTL is long enough for a correction review cycle
// but finite; clients can call POST /corrections/attachment/sign to refresh.
const ATTACHMENT_BUCKET = 'attachments';
const ATTACHMENT_URL_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

async function signAttachmentPath(path) {
  const { data, error } = await adminSupabase.storage
    .from(ATTACHMENT_BUCKET)
    .createSignedUrl(path, ATTACHMENT_URL_TTL_SECONDS);
  if (error) throw new ApiError(`Could not sign attachment URL: ${error.message}`);
  return { url: data.signedUrl, expiresIn: ATTACHMENT_URL_TTL_SECONDS };
}

// Placement id is the first path segment after `corrections/` — see upload path format.
function placementIdFromPath(path) {
  const m = /^corrections\/([^/]+)\//.exec(path || '');
  return m ? m[1] : null;
}

// Authorize a user to read an attachment identified by its storage path.
async function assertAttachmentAccess(user, path) {
  if (!path || !path.startsWith('corrections/')) throw new ApiError('Invalid attachment path', 400);
  if (user.role?.startsWith('agency_')) return;

  const placementId = placementIdFromPath(path);
  if (!placementId) throw new ApiError('Forbidden', 403);

  if (user.role === 'placement') {
    const { data: pl } = await adminSupabase
      .from('placements').select('id').eq('user_profile_id', user.id).maybeSingle();
    if (!pl || pl.id !== placementId) throw new ApiError('Forbidden', 403);
    return;
  }

  if (user.role === 'company_admin' || user.role === 'company_user') {
    const companyIds = await companyIdsForUser(user);
    if (!companyIds?.length) throw new ApiError('Forbidden', 403);
    const { data: pl } = await adminSupabase
      .from('placements').select('id')
      .eq('id', placementId)
      .in('company_id', companyIds)
      .maybeSingle();
    if (!pl) throw new ApiError('Forbidden', 403);
    return;
  }

  throw new ApiError('Forbidden', 403);
}

// POST /corrections/upload — upload proof attachment to Supabase Storage.
// Returns a short-lived signed URL plus the storage path. Clients should
// persist `path` (not `url`) and call /corrections/attachment/sign to refresh.
router.post('/upload', requireAuth, async (req, res, next) => {
  try {
    // Simple base64 upload via request body
    const { fileBase64, fileName, mimeType, placementId, date } = req.body;
    if (!fileBase64 || !fileName) throw new ApiError('fileBase64 and fileName required', 400);

    const buffer = Buffer.from(fileBase64, 'base64');
    const path   = `corrections/${placementId}/${date}/${Date.now()}_${fileName}`;

    const { error } = await adminSupabase.storage
      .from(ATTACHMENT_BUCKET)
      .upload(path, buffer, { contentType: mimeType || 'application/octet-stream', upsert: false });

    if (error) throw new ApiError(error.message);

    const { url, expiresIn } = await signAttachmentPath(path);
    res.json({ url, name: fileName, path, expiresIn });
  } catch (err) { next(err); }
});

// POST /corrections/attachment/sign — mint a fresh signed URL for a stored path.
// Authorization is checked per user/role; placements can only access their own
// attachments, company users their company's, agency users anything.
router.post('/attachment/sign', requireAuth, async (req, res, next) => {
  try {
    const { path } = req.body;
    if (!path) throw new ApiError('path is required', 400);
    await assertAttachmentAccess(req.user, path);
    const { url, expiresIn } = await signAttachmentPath(path);
    res.json({ url, path, expiresIn });
  } catch (err) { next(err); }
});


// DELETE /corrections/:id — placement (own pending) or company_admin (own approved company corrections)
router.delete('/:id', async (req, res, next) => {
  try {
    const { user } = req;

    // Fetch correction
    const { data: correction, error: fetchErr } = await adminSupabase
      .from('charge_corrections')
      .select('id, status, correction_type, placement_id, period_id, attachment_url')
      .eq('id', req.params.id)
      .single();

    if (fetchErr || !correction) throw new ApiError('Correction not found', 404);

    if (user.role === 'placement') {
      // Placement: can only delete their own pending corrections
      if (correction.status !== 'pending') {
        throw new ApiError('Only pending corrections can be deleted', 400);
      }
      const { data: placement } = await adminSupabase
        .from('placements').select('id').eq('user_profile_id', user.id).maybeSingle();
      if (!placement || placement.id !== correction.placement_id) {
        throw new ApiError('Forbidden', 403);
      }
    } else if (user.role === 'company_admin' || user.role === 'company_user') {
      // Company: can only delete their own COMPANY-type corrections
      if (correction.correction_type !== 'COMPANY') {
        throw new ApiError('Company users can only delete company corrections', 403);
      }
      // Verify the placement belongs to any of the user's companies
      const companyIds = await companyIdsForUser(user);
      if (!companyIds?.length) throw new ApiError('Forbidden', 403);
      const { data: placement } = await adminSupabase
        .from('placements').select('id')
        .eq('id', correction.placement_id)
        .in('company_id', companyIds)
        .maybeSingle();
      if (!placement) throw new ApiError('Forbidden', 403);
    } else if (!user.role?.startsWith('agency_')) {
      throw new ApiError('Forbidden', 403);
    }

    // Delete the correction
    const { error } = await adminSupabase
      .from('charge_corrections')
      .delete()
      .eq('id', req.params.id);

    if (error) throw new ApiError(error.message);

    // If a company correction was deleted, check if sync should be unlocked
    // Unlock only if no remaining COMPANY corrections exist for this placement/period
    if (correction.correction_type === 'COMPANY' && correction.period_id) {
      const { data: remaining } = await adminSupabase
        .from('charge_corrections')
        .select('id')
        .eq('placement_id', correction.placement_id)
        .eq('period_id', correction.period_id)
        .eq('correction_type', 'COMPANY')
        .limit(1);

      if (!remaining?.length) {
        await adminSupabase
          .from('roster_period_status')
          .update({ sync_locked: false, sync_locked_at: null, sync_locked_by: null })
          .eq('placement_id', correction.placement_id)
          .eq('period_id', correction.period_id);
      }
    }

    logger.info('Correction deleted', { id: req.params.id, by: user.id });
    res.json({ deleted: true, id: req.params.id });
  } catch (err) { next(err); }
});

export default router;

// ─────────────────────────────────────────────────────────────────────────────
// NEW: Placement correction requests via charge_corrections table
// ─────────────────────────────────────────────────────────────────────────────

// GET /corrections/placement/:periodId — corrections for a period
router.get('/placement/:periodId', async (req, res, next) => {
  try {
    const { data, error } = await adminSupabase
      .from('charge_corrections')
      .select('*')
      .eq('period_id', req.params.periodId)
      .order('correction_date', { ascending: true });
    if (error) throw new ApiError(error.message);
    res.json(data || []);
  } catch (err) { next(err); }
});

// POST /corrections — create new placement correction request
router.post('/', async (req, res, next) => {
  try {
    const { user } = req;

    // Get placement for this user
    const { data: placement } = await adminSupabase
      .from('placements')
      .select('id')
      .eq('user_profile_id', user.id)
      .maybeSingle();
    if (!placement) throw new ApiError('No placement found for user', 403);

    const {
      period_id, correction_date, correction_type, charge_codes,
      reason, rotation_start, rotation_end,
      overtime_hhmm, overtime_decimal,
    } = req.body;

    if (!period_id || !correction_date || !correction_type || !reason) {
      throw new ApiError('period_id, correction_date, correction_type and reason are required', 400);
    }

    const VALID_TYPES = ['PAID', 'PAID_OFF_PD', 'SOLD_DAY', 'BOD_DAY', 'OVERTIME', 'INLINE'];
    if (!VALID_TYPES.includes(correction_type)) {
      throw new ApiError(`Invalid correction_type. Must be one of: ${VALID_TYPES.join(', ')}`, 400);
    }

    if (correction_type === 'OVERTIME' && (!overtime_hhmm || overtime_decimal === undefined)) {
      throw new ApiError('overtime_hhmm and overtime_decimal are required for OVERTIME corrections', 400);
    }

    const { data, error } = await adminSupabase
      .from('charge_corrections')
      .insert({
        placement_id:     placement.id,
        period_id,
        correction_date,
        correction_type,
        charge_codes:     charge_codes || [],
        reason,
        rotation_start:               rotation_start                || null,
        rotation_end:                 rotation_end                  || null,
        overtime_hhmm:                overtime_hhmm                 || null,
        overtime_decimal:             overtime_decimal              || null,
        blh_hhmm:                     req.body.blh_hhmm             || null,
        blh_decimal:                  req.body.blh_decimal          || null,
        is_rotation_end_correction:   req.body.is_rotation_end_correction || false,
        attachment_url:               req.body.attachment_url       || null,
        attachment_name:              req.body.attachment_name      || null,
        status:                       'pending',
        requested_by:                 user.id,
      })
      .select()
      .single();

    if (error) throw new ApiError(error.message);
    res.status(201).json(data);
  } catch (err) { next(err); }
});

// PUT /corrections/:id/status — approve or decline
router.put('/:id/status', requireCompanyOrAbove, async (req, res, next) => {
  try {
    const { status, review_note } = req.body;
    if (!['approved', 'declined'].includes(status)) {
      throw new ApiError('status must be approved or declined', 400);
    }
    if (status === 'declined' && !review_note) {
      throw new ApiError('review_note is required when declining', 400);
    }

    const { data, error } = await adminSupabase
      .from('charge_corrections')
      .update({
        status,
        review_note:  review_note || null,
        reviewed_by:  req.user.id,
        updated_at:   new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw new ApiError(error.message);
    res.json(data);
  } catch (err) { next(err); }
});
