/**
 * Carerix routes
 *
 * GET  /carerix/test              — Full connection diagnostic (no auth)
 * POST /carerix/sync/fees/:id     — Re-trigger fee retrieval (Agency)
 * GET  /carerix/fees/status/:id   — Fee retrieval status (Agency)
 */
import { Router } from 'express';
import { requireAuth, requireAgency } from '../middleware/auth.js';
import { adminSupabase } from '../services/supabase.js';
import { fetchAndCacheFee, testCarerixConnection } from '../services/carerix.js';
import { ApiError } from '../middleware/errorHandler.js';

const router = Router();

// ── GET /carerix/test — no auth required ──────────────────────────────────────
router.get('/test', async (req, res) => {
  const results = await testCarerixConnection();
  res.json(results);
});

// ── Protected routes ──────────────────────────────────────────────────────────
router.use(requireAuth, requireAgency);

// POST /carerix/sync/fees/:periodId
router.post('/sync/fees/:periodId', async (req, res, next) => {
  try {
    const { data: entries } = await adminSupabase
      .from('declaration_entries')
      .select('id, entry_date, imported_amount, fee_retrieval_status, declaration_types(code), placements(placement_ref), companies(company_ref)')
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
          fee_cache_id:         result.id,
          fee_amount:           result.fee_amount,
          fee_retrieval_status: 'retrieved',
          calculated_value:     entry.imported_amount * result.fee_amount,
          status:               'fee_retrieved',
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

// GET /carerix/fees/status/:periodId
router.get('/fees/status/:periodId', async (req, res, next) => {
  try {
    const { data, error } = await adminSupabase
      .from('declaration_entries')
      .select('fee_retrieval_status')
      .eq('payroll_period_id', req.params.periodId);
    if (error) throw new ApiError(error.message);
    const summary = data.reduce((acc, row) => {
      acc[row.fee_retrieval_status] = (acc[row.fee_retrieval_status] || 0) + 1;
      return acc;
    }, {});
    res.json(summary);
  } catch (err) { next(err); }
});

export default router;
