/**
 * Payroll routes
 *
 * GET  /payroll/periods               — List periods (role-filtered via RLS)
 * POST /payroll/periods               — Create period (Agency only)
 * GET  /payroll/periods/:id           — Period detail
 * GET  /payroll/periods/:id/planner   — Monthly planner matrix
 * GET  /payroll/entries/:id           — Declaration entry detail + audit history
 */
import { Router } from 'express';
import { requireAuth, requireAgency } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth);

router.get('/periods', async (req, res, next) => {
  try {
    const { data, error } = await req.supabase
      .from('payroll_periods')
      .select('*')
      .order('year',  { ascending: false })
      .order('month', { ascending: false });
    if (error) throw new ApiError(error.message);
    res.json(data);
  } catch (err) { next(err); }
});

router.post('/periods', requireAgency, async (req, res, next) => {
  try {
    const { month, year, start_date, end_date, notes } = req.body;
    if (!month || !year || !start_date || !end_date)
      throw new ApiError('month, year, start_date and end_date are required');

    const { data, error } = await req.supabase
      .from('payroll_periods')
      .insert({ month, year, start_date, end_date, notes, created_by: req.user.id })
      .select()
      .single();
    if (error) throw new ApiError(error.message);
    res.status(201).json(data);
  } catch (err) { next(err); }
});

router.get('/periods/:id', async (req, res, next) => {
  try {
    const { data, error } = await req.supabase
      .from('payroll_periods')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error || !data) throw new ApiError('Period not found', 404);
    res.json(data);
  } catch (err) { next(err); }
});

/**
 * Monthly planner matrix
 * Returns a nested structure: { date → { DECL_TYPE_CODE → entry+corrections } }
 * so the frontend can render the day × declaration-type grid directly.
 */
router.get('/periods/:id/planner', async (req, res, next) => {
  try {
    const { placement_id } = req.query;

    let query = req.supabase
      .from('declaration_entries')
      .select(`
        id, entry_date, imported_amount, approved_amount,
        fee_amount, calculated_value, status, current_approval_stage,
        fee_retrieval_status,
        declaration_types ( id, code, label, unit ),
        placements        ( id, full_name, placement_ref ),
        correction_requests (
          id, requested_amount, original_amount,
          status, note, decline_reason, created_at
        )
      `)
      .eq('payroll_period_id', req.params.id)
      .order('entry_date');

    if (placement_id) query = query.eq('placement_id', placement_id);

    const { data, error } = await query;
    if (error) throw new ApiError(error.message);

    // Build the matrix: { "2026-04-03" → { "REG_HOURS" → { … } } }
    const matrix = {};
    for (const entry of data) {
      const date = entry.entry_date;
      const code = entry.declaration_types.code;
      if (!matrix[date]) matrix[date] = {};
      matrix[date][code] = {
        entryId:          entry.id,
        importedAmount:   entry.imported_amount,
        approvedAmount:   entry.approved_amount,
        feeAmount:        entry.fee_amount,
        calculatedValue:  entry.calculated_value,
        status:           entry.status,
        approvalStage:    entry.current_approval_stage,
        feeStatus:        entry.fee_retrieval_status,
        placement:        entry.placements,
        declarationType:  entry.declaration_types,
        corrections:      entry.correction_requests ?? [],
      };
    }

    res.json({ periodId: req.params.id, matrix });
  } catch (err) { next(err); }
});

router.get('/entries/:id', async (req, res, next) => {
  try {
    const { data, error } = await req.supabase
      .from('declaration_entries')
      .select(`
        *,
        declaration_types (*),
        placements (*),
        companies (*),
        correction_requests (*),
        approval_actions ( * )
      `)
      .eq('id', req.params.id)
      .single();
    if (error || !data) throw new ApiError('Entry not found', 404);
    res.json(data);
  } catch (err) { next(err); }
});

export default router;
