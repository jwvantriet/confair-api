/**
 * Client-error log. Frontend axios interceptor POSTs to /errors/log on every
 * failed request; the agency-only GET /errors returns recent ones for inspection
 * at /dashboard/errors.
 */
import { Router } from 'express';
import { adminSupabase } from '../services/supabase.js';
import { requireAuth, requireAgency } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';

const router = Router();

// ── POST /errors/log — record a client-side error (auth only) ─────────────────
router.post('/log', requireAuth, async (req, res, next) => {
  try {
    const { section, action, http_status, error_message, context } = req.body || {};
    if (!error_message) throw new ApiError('error_message required', 400);

    const row = {
      user_id:       req.user?.id || null,
      user_role:     req.user?.role || null,
      user_email:    req.user?.email || null,
      section:       section       ? String(section).slice(0, 200)       : null,
      action:        action        ? String(action).slice(0, 200)        : null,
      http_status:   Number.isInteger(http_status) ? http_status : null,
      error_message: String(error_message).slice(0, 2000),
      context:       context && typeof context === 'object' ? context : null,
      user_agent:    String(req.get('user-agent') || '').slice(0, 500),
    };

    const { data, error } = await adminSupabase
      .from('client_errors').insert(row).select('id').single();

    if (error) throw new ApiError(error.message, 500);
    res.status(201).json({ id: data.id });
  } catch (err) { next(err); }
});

// ── GET /errors — agency-only list ────────────────────────────────────────────
router.get('/', requireAuth, requireAgency, async (req, res, next) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const before = req.query.before ? new Date(req.query.before) : null; // pagination cursor

    let q = adminSupabase
      .from('client_errors')
      .select('id, occurred_at, user_id, user_role, user_email, section, action, http_status, error_message, context')
      .order('occurred_at', { ascending: false })
      .limit(limit);

    if (before && !isNaN(before.getTime())) q = q.lt('occurred_at', before.toISOString());

    const { data, error } = await q;
    if (error) throw new ApiError(error.message, 500);

    res.json({ items: data || [], nextCursor: data?.length === limit ? data[data.length - 1].occurred_at : null });
  } catch (err) { next(err); }
});

// ── DELETE /errors/:id — agency only, purge a single record ───────────────────
router.delete('/:id', requireAuth, requireAgency, async (req, res, next) => {
  try {
    const { error } = await adminSupabase.from('client_errors').delete().eq('id', req.params.id);
    if (error) throw new ApiError(error.message, 500);
    res.json({ deleted: true, id: req.params.id });
  } catch (err) { next(err); }
});

export default router;
