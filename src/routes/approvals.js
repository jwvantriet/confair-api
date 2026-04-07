/**
 * Approvals routes
 *
 * GET   /approvals                  — List entries awaiting current user's action
 * POST  /approvals/:entryId/approve — Approve a declaration entry
 * POST  /approvals/:entryId/decline — Decline with mandatory reason
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { adminSupabase } from '../services/supabase.js';
import { ApiError } from '../middleware/errorHandler.js';
import { writeAuditLog } from '../utils/audit.js';

const router = Router();
router.use(requireAuth);

// Approval stage transitions per role
const NEXT_STAGE = {
  company_initial: 'placement',
  placement:       'company_final',
  company_final:   null,   // fully approved
};

const STAGE_FOR_ROLE = {
  company_admin: ['company_initial', 'company_final'],
  company_user:  ['company_initial', 'company_final'],
  placement:     ['placement'],
  agency_admin:  ['company_initial', 'placement', 'company_final'],
  agency_operations: ['company_initial', 'placement', 'company_final'],
};

// GET /approvals — entries awaiting this user's action
router.get('/', async (req, res, next) => {
  try {
    const stages = STAGE_FOR_ROLE[req.user.role] || [];
    const { data, error } = await req.supabase
      .from('declaration_entries')
      .select(`
        id, entry_date, imported_amount, status, current_approval_stage,
        declaration_types(code, label, unit),
        placements(id, full_name),
        companies(id, name)
      `)
      .in('current_approval_stage', stages)
      .in('status', ['pending_company_initial','pending_placement','pending_company_final'])
      .order('entry_date');
    if (error) throw new ApiError(error.message);
    res.json(data);
  } catch (err) { next(err); }
});

// POST /approvals/:entryId/approve
router.post('/:entryId/approve', async (req, res, next) => {
  try {
    const { note } = req.body;
    const { data: entry, error } = await adminSupabase
      .from('declaration_entries')
      .select('id, status, current_approval_stage, imported_amount, fee_amount')
      .eq('id', req.params.entryId)
      .single();

    if (error || !entry) throw new ApiError('Entry not found', 404);

    // Check this user can act on this stage
    const allowedStages = STAGE_FOR_ROLE[req.user.role] || [];
    if (!allowedStages.includes(entry.current_approval_stage)) {
      throw new ApiError('You are not authorised to act on this approval stage', 403);
    }

    const nextStage = NEXT_STAGE[entry.current_approval_stage];
    const isFullyApproved = nextStage === null;

    const nextStatus = isFullyApproved
      ? 'approved'
      : `pending_${nextStage.replace('_', '_')}`;

    // Record approval action
    await adminSupabase.from('approval_actions').insert({
      entity_type:  'declaration_entry',
      entity_id:    entry.id,
      stage:        entry.current_approval_stage,
      action:       'approved',
      actor_user_id: req.user.id,
      actor_role:   req.user.role,
      note,
    });

    // Update entry
    const updatePayload = {
      status:                nextStatus,
      current_approval_stage: nextStage,
      ...(isFullyApproved && {
        approved_amount: entry.imported_amount,
        approved_value:  entry.fee_amount
          ? (entry.imported_amount * entry.fee_amount)
          : null,
      }),
    };

    await adminSupabase
      .from('declaration_entries')
      .update(updatePayload)
      .eq('id', entry.id);

    await writeAuditLog({
      eventType:  'approval_approved',
      actorUserId: req.user.id,
      actorRole:  req.user.role,
      entityType: 'declaration_entry',
      entityId:   entry.id,
      payload:    { stage: entry.current_approval_stage, nextStage, note },
    });

    res.json({ message: isFullyApproved ? 'Entry fully approved' : `Moved to ${nextStage}`, nextStage });
  } catch (err) { next(err); }
});

// POST /approvals/:entryId/decline
router.post('/:entryId/decline', async (req, res, next) => {
  try {
    const { declineReason } = req.body;
    if (!declineReason?.trim()) {
      throw new ApiError('declineReason is mandatory when declining an entry', 400);
    }

    const { data: entry, error } = await adminSupabase
      .from('declaration_entries')
      .select('id, current_approval_stage')
      .eq('id', req.params.entryId)
      .single();
    if (error || !entry) throw new ApiError('Entry not found', 404);

    const allowedStages = STAGE_FOR_ROLE[req.user.role] || [];
    if (!allowedStages.includes(entry.current_approval_stage)) {
      throw new ApiError('You are not authorised to act on this approval stage', 403);
    }

    await adminSupabase.from('approval_actions').insert({
      entity_type:   'declaration_entry',
      entity_id:     entry.id,
      stage:         entry.current_approval_stage,
      action:        'declined',
      actor_user_id: req.user.id,
      actor_role:    req.user.role,
      decline_reason: declineReason,
    });

    await adminSupabase
      .from('declaration_entries')
      .update({ status: 'declined', current_approval_stage: null })
      .eq('id', entry.id);

    await writeAuditLog({
      eventType:  'approval_declined',
      actorUserId: req.user.id,
      actorRole:  req.user.role,
      entityType: 'declaration_entry',
      entityId:   entry.id,
      payload:    { stage: entry.current_approval_stage, declineReason },
    });

    res.json({ message: 'Entry declined' });
  } catch (err) { next(err); }
});

export default router;
