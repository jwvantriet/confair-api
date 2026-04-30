/**
 * Diagnostic: report which Postgres role the API connection is actually
 * operating as. If service_role's BYPASSRLS is correctly configured but
 * the API still hits RLS errors, the connection is probably being
 * downgraded to anon — and this endpoint proves it.
 *
 * Requires the SQL function `public.who_am_i()` to exist (see migration
 * docs/migrations/2026-04-29-who-am-i.sql).
 */

import { Router } from 'express';
import { adminSupabase } from '../services/supabase.js';
import { requireAuth, requireAgency } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';

const router = Router();

router.get('/role', requireAuth, requireAgency, async (req, res, next) => {
  try {
    const { data, error } = await adminSupabase.rpc('who_am_i');
    if (error) throw new ApiError(`who_am_i rpc: ${error.message}`, 500);

    // Also try a direct read against a table we know has RLS enabled.
    const { data: ctData, count: ctCount, error: ctErr } = await adminSupabase
      .from('charge_types')
      .select('id', { count: 'exact', head: false })
      .limit(3);

    res.json({
      whoAmI: data,
      directReadTest: {
        table:        'charge_types',
        rowsReturned: ctData?.length ?? 0,
        countHeader:  ctCount ?? null,
        error:        ctErr?.message ?? null,
        sample:       (ctData || []).map(r => r.id),
      },
    });
  } catch (err) { next(err); }
});

export default router;
