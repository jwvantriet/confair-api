/**
 * Runs routes — Agency only for write operations
 *
 * GET  /runs                    — List all runs
 * GET  /runs/:id                — Run detail with entries
 * POST /runs/:id/finalize       — Finalize run (Agency only) → triggers invoicing
 */

import { Router } from 'express';
import { requireAuth, requireAgency } from '../middleware/auth.js';
import { adminSupabase } from '../services/supabase.js';
import { ApiError } from '../middleware/errorHandler.js';
import { writeAuditLog } from '../utils/audit.js';
import { generateInvoicesForRun } from './invoices.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await req.supabase
      .from('payroll_runs')
      .select('*, payroll_periods(period_ref, month, year)')
      .order('created_at', { ascending: false });
    if (error) throw new ApiError(error.message);
    res.json(data);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { data, error } = await req.supabase
      .from('payroll_runs')
      .select(`
        *, payroll_periods(*),
        payroll_run_entries(
          id, amount,
          declaration_entries(id, entry_date, imported_amount, declaration_types(label)),
          correction_requests(id, correction_date, requested_amount, declaration_types(label))
        )
      `)
      .eq('id', req.params.id)
      .single();
    if (error || !data) throw new ApiError('Run not found', 404);
    res.json(data);
  } catch (err) { next(err); }
});

// POST /runs/:id/finalize — Agency only, locks run and triggers invoices
router.post('/:id/finalize', requireAgency, async (req, res, next) => {
  try {
    const { data: run, error } = await adminSupabase
      .from('payroll_runs')
      .select('*, payroll_periods(*)')
      .eq('id', req.params.id)
      .single();
    if (error || !run) throw new ApiError('Run not found', 404);
    if (run.status === 'finalized') throw new ApiError('Run is already finalized');

    // Lock the run
    await adminSupabase.from('payroll_runs').update({
      status:       'finalized',
      finalized_by: req.user.id,
      finalized_at: new Date().toISOString(),
    }).eq('id', run.id);

    // Mark all included entries as finalized
    await adminSupabase.from('declaration_entries')
      .update({ status: 'finalized' })
      .eq('status', 'approved')
      .in('id',
        (await adminSupabase.from('payroll_run_entries')
          .select('declaration_entry_id')
          .eq('payroll_run_id', run.id)
          .not('declaration_entry_id', 'is', null)
        ).data?.map(r => r.declaration_entry_id) ?? []
      );

    // Generate invoices
    const invoices = await generateInvoicesForRun(run.id, req.user.id);

    await writeAuditLog({
      eventType: 'run_finalized', actorUserId: req.user.id, actorRole: req.user.role,
      entityType: 'payroll_run', entityId: run.id,
      payload: { invoiceCount: invoices.length },
    });

    res.json({ message: 'Run finalized', runId: run.id, invoicesGenerated: invoices.length, invoices });
  } catch (err) { next(err); }
});

export default router;
