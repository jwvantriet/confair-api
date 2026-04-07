/**
 * Auth routes
 *
 * POST /auth/login/agency    — Supabase email/password  (Agency users)
 * POST /auth/login/carerix   — Carerix Graph API         (Placement + Company)
 * POST /auth/refresh         — Refresh any session
 * POST /auth/logout          — Revoke session
 * GET  /auth/me              — Current user profile
 */
import { Router } from 'express';
import { z } from 'zod';
import { adminSupabase, provisionCarerixSession } from '../services/supabase.js';
import { authenticateWithCarerix, syncIdentityCache } from '../services/carerix.js';
import { requireAuth } from '../middleware/auth.js';
import { ApiError }    from '../middleware/errorHandler.js';
import { writeAuditLog } from '../utils/audit.js';
import { logger }      from '../utils/logger.js';

const router = Router();

const agencySchema  = z.object({ email: z.string().email(), password: z.string().min(8) });
const carerixSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
  roleHint: z.enum(['placement','company']).optional(),
});

// ── POST /auth/login/agency ───────────────────────────────────────────────────
router.post('/login/agency', async (req, res, next) => {
  try {
    const parsed = agencySchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(parsed.error.issues[0].message, 400);
    const { email, password } = parsed.data;

    const { data, error } = await adminSupabase.auth.signInWithPassword({ email, password });
    if (error) { logger.warn('Agency login failed', { email }); throw new ApiError('Invalid email or password', 401); }

    const { data: profile } = await adminSupabase
      .from('user_profiles')
      .select('role, display_name, is_active')
      .eq('id', data.user.id)
      .single();

    if (!profile?.role?.startsWith('agency_')) throw new ApiError('Invalid email or password', 401);
    if (!profile.is_active) throw new ApiError('Account is inactive', 403);

    await writeAuditLog({ eventType: 'login_agency', actorUserId: data.user.id, actorRole: profile.role, payload: { email }, ipAddress: req.ip });

    res.json({
      accessToken:  data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresAt:    data.session.expires_at,
      user: { id: data.user.id, email: data.user.email, displayName: profile.display_name, role: profile.role, authSource: 'supabase' },
    });
  } catch (err) { next(err); }
});

// ── POST /auth/login/carerix ──────────────────────────────────────────────────
router.post('/login/carerix', async (req, res, next) => {
  try {
    const parsed = carerixSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(parsed.error.issues[0].message, 400);
    const { email, password, roleHint } = parsed.data;

    // 1. Validate credentials against Carerix Graph API
    let identity;
    try {
      identity = await authenticateWithCarerix(email, password);
    } catch (err) {
      logger.warn('Carerix login failed', { email, error: err.message });
      throw new ApiError('Invalid Carerix credentials', 401);
    }

    // 2. Optional role hint check — gives the frontend a better error message
    if (roleHint) {
      const isPlacement = identity.platformRole === 'placement';
      const isCompany   = ['company_admin','company_user'].includes(identity.platformRole);
      if (roleHint === 'placement' && !isPlacement) throw new ApiError('This account is not a Placement', 403);
      if (roleHint === 'company'   && !isCompany)   throw new ApiError('This account is not a Company user', 403);
    }

    // 3. Sync identity cache (fire-and-forget — does not block the response)
    syncIdentityCache(identity).catch(e => logger.error('Identity cache sync failed', { e }));

    // 4. Provision (or refresh) the Supabase session for this Carerix user
    const session = await provisionCarerixSession(identity);

    await writeAuditLog({
      eventType: 'login_carerix', actorUserId: session.userId, actorRole: identity.platformRole,
      payload: { email, carerixUserId: identity.carerixUserId }, ipAddress: req.ip,
    });

    res.json({
      accessToken:  session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt:    session.expiresAt,
      user: {
        id:              session.userId,
        email:           identity.email,
        displayName:     identity.fullName,
        role:            identity.platformRole,
        authSource:      'carerix',
        carerixUserId:   identity.carerixUserId,
        carerixCompanyId: identity.carerixCompanyId,
      },
    });
  } catch (err) { next(err); }
});

// ── POST /auth/refresh ────────────────────────────────────────────────────────
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) throw new ApiError('refreshToken is required', 400);
    const { data, error } = await adminSupabase.auth.refreshSession({ refresh_token: refreshToken });
    if (error) throw new ApiError('Invalid or expired refresh token', 401);
    res.json({ accessToken: data.session.access_token, refreshToken: data.session.refresh_token, expiresAt: data.session.expires_at });
  } catch (err) { next(err); }
});

// ── POST /auth/logout ─────────────────────────────────────────────────────────
router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await adminSupabase.auth.admin.signOut(req.token);
    await writeAuditLog({ eventType: 'logout', actorUserId: req.user.id, actorRole: req.user.role, ipAddress: req.ip });
    res.json({ message: 'Logged out successfully' });
  } catch (err) { next(err); }
});

// ── GET /auth/me ──────────────────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  const { id, role, auth_source, display_name, email, carerix_user_id, carerix_company_id } = req.user;
  res.json({ id, role, authSource: auth_source, displayName: display_name, email, carerixUserId: carerix_user_id, carerixCompanyId: carerix_company_id });
});

export default router;
