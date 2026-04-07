/**
 * Carerix sync routes — Agency only
 *
 * POST /carerix/sync/fees/:periodId  — Re-trigger fee retrieval for a period
 * GET  /carerix/fees/status/:periodId — Fee retrieval status for all entries
 * POST /carerix/sync/identity/:userId — Refresh a user's Carerix profile
 */

import { Router } from 'express';
import { requireAuth, requireAgency } from '../middleware/auth.js';
import { adminSupabase } from '../services/supabase.js';
import { fetchAndCacheFee } from '../services/carerix.js';
import { ApiError } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth, requireAgency);

// Trigger fee retrieval for all pending entries in a period
router.post('/sync/fees/:periodId', async (req, res, next) => {
  try {
    const { data: entries } = await adminSupabase
      .from('declaration_entries')
      .select('id, carerix_fee_cache(carerix_placement_ref), declaration_types(code), placements(placement_ref), companies(company_ref), entry_date')
      .eq('payroll_period_id', req.params.periodId)
      .eq('fee_retrieval_status', 'pending');

    if (!entries?.length) return res.json({ message: 'No pending fee retrievals', count: 0 });

    let retrieved = 0, failed = 0;
    for (const entry of entries) {
      const result = await fetchAndCacheFee(
        entry.placements.placement_ref,
        entry.companies.company_ref,
        entry.declaration_types.code,
        entry.entry_date
      );
      if (result?.retrieval_status === 'retrieved') {
        await adminSupabase.from('declaration_entries').update({
          fee_cache_id:        result.id,
          fee_amount:          result.fee_amount,
          fee_retrieval_status: 'retrieved',
          calculated_value:    entry.imported_amount * result.fee_amount,
          status:              'fee_retrieved',
        }).eq('id', entry.id);
        retrieved++;
      } else {
        await adminSupabase.from('declaration_entries').update({
          fee_retrieval_status: 'failed',
          status:               'fee_retrieval_failed',
        }).eq('id', entry.id);
        failed++;
      }
    }
    res.json({ message: 'Fee sync complete', retrieved, failed, total: entries.length });
  } catch (err) { next(err); }
});

// Fee retrieval status overview for a period
router.get('/fees/status/:periodId', async (req, res, next) => {
  try {
    const { data, error } = await adminSupabase
      .from('declaration_entries')
      .select('fee_retrieval_status, count:id.count()')
      .eq('payroll_period_id', req.params.periodId);
    if (error) throw new ApiError(error.message);
    res.json(data);
  } catch (err) { next(err); }
});

export default router;
