/**
 * Admin endpoints for the rotations table. Agency-only.
 *
 *   POST /rotations/backfill?lookbackMonths=4   — recompute all placements
 *   POST /rotations/backfill/:placementId       — recompute one placement
 *   GET  /rotations/:placementId                — list a placement's rotations
 *   GET  /rotations/carryover/:placementId/:periodStart  — carry-over BLH
 */
import { Router } from 'express';
import { adminSupabase } from '../services/supabase.js';
import { requireAuth, requireAgency } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';
import {
  backfillAllRotations,
  recomputePlacementRotations,
  getCarryoverBLH,
} from '../services/rotations.js';

const router = Router();
router.use(requireAuth, requireAgency);

router.post('/backfill', async (req, res, next) => {
  try {
    const lookbackMonths = Math.max(1, Math.min(24, parseInt(req.query.lookbackMonths, 10) || 4));
    const result = await backfillAllRotations({ lookbackMonths });
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/backfill/:placementId', async (req, res, next) => {
  try {
    const lookbackMonths = Math.max(1, Math.min(24, parseInt(req.query.lookbackMonths, 10) || 4));
    const result = await recomputePlacementRotations(req.params.placementId, { lookbackMonths });
    res.json(result);
  } catch (err) { next(err); }
});

router.get('/:placementId', async (req, res, next) => {
  try {
    const { data, error } = await adminSupabase
      .from('rotations')
      .select('*')
      .eq('placement_id', req.params.placementId)
      .order('start_date', { ascending: false });
    if (error) throw new ApiError(error.message, 500);
    res.json({ items: data || [] });
  } catch (err) { next(err); }
});

router.get('/carryover/:placementId/:periodStart', async (req, res, next) => {
  try {
    const blh = await getCarryoverBLH(req.params.placementId, req.params.periodStart);
    res.json({ placement_id: req.params.placementId, period_start: req.params.periodStart, carryover_blh: blh });
  } catch (err) { next(err); }
});

export default router;
