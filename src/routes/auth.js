/**
 * Auth routes
 *
 * POST /auth/login/agency          — Supabase email/password (Agency)
 * GET  /auth/carerix/login         — Redirect to Carerix login page
 * GET  /auth/carerix/callback      — OAuth2 callback from Carerix
 * POST /auth/refresh               — Refresh any session
 * POST /auth/logout                — Revoke session
 * GET  /auth/me                    — Current user profile
 */
import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { adminSupabase, provisionCarerixSession } from '../services/supabase.js';
import {
  getCarerixAuthUrl,
  exchangeCodeForTokens,
  getCarerixUserInfo,
  syncIdentityCache,
} from '../services/carerix.js';
import { requireAuth } from '../middleware/auth.js';
import { ApiError }    from '../middleware/errorHandler.js';
import { writeAuditLog } from '../utils/audit.js';
import { logger }      from '../utils/logger.js';
import { config }      from '../config.js';

const router = Router();

// In-memory state store (replace with Redis for multi-instance)
const oauthStates = new Map();

const agencySchema = z.object({
  email:    z.string().email(),
  password: z.string().min(8),
});

// ── POST /auth/login/agency ───────────────────────────────────────────────────
router.post('/login/agency', async (req, res, next) => {
  try {
    const parsed = agencySchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(parsed.error.issues[0].message, 400);
    const { email, password } = parsed.data;

    const { data, error } = await adminSupabase.auth.signInWithPassword({ email, password });
    if (error) {
      logger.warn('Agency login failed', { email });
      throw new ApiError('Invalid email or password', 401);
    }

    const { data: profile } = await adminSupabase
      .from('user_profiles')
      .select('role, display_name, is_active')
      .eq('id', data.user.id)
      .single();

    if (!profile?.role?.startsWith('agency_')) throw new ApiError('Invalid email or password', 401);
    if (!profile.is_active) throw new ApiError('Account is inactive', 403);

    await writeAuditLog({
      eventType:   'login_agency',
      actorUserId: data.user.id,
      actorRole:   profile.role,
      payload:     { email },
      ipAddress:   req.ip,
    });

    res.json({
      accessToken:  data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresAt:    data.session.expires_at,
      user: {
        id:          data.user.id,
        email:       data.user.email,
        displayName: profile.display_name,
        role:        profile.role,
        authSource:  'supabase',
      },
    });
  } catch (err) { next(err); }
});

// ── GET /auth/carerix/login — redirect to Carerix login page ──────────────────
// Query params: roleHint=company|placement
router.get('/carerix/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const roleHint = req.query.roleHint || 'placement';
  const redirectUri = `${config.appUrl}/auth/carerix/callback`;

  // Store state with roleHint so callback knows what we expected
  oauthStates.set(state, {
    roleHint,
    createdAt: Date.now(),
    redirectUri,
  });

  // Clean up old states (older than 10 minutes)
  for (const [k, v] of oauthStates.entries()) {
    if (Date.now() - v.createdAt > 10 * 60 * 1000) oauthStates.delete(k);
  }

  const authUrl = getCarerixAuthUrl(state, redirectUri);
  logger.info('Carerix OAuth redirect', { roleHint, state: state.slice(0, 8) });
  res.redirect(authUrl);
});

// ── GET /auth/carerix/callback — OAuth2 callback ──────────────────────────────
router.get('/carerix/callback', async (req, res, next) => {
  try {
    const { code, state, error: oauthError, error_description } = req.query;

    if (oauthError) {
      logger.warn('Carerix OAuth error', { error: oauthError, description: error_description });
      const frontendUrl = config.cors.origins[0] || 'https://confair-platform.vercel.app';
      return res.redirect(`${frontendUrl}/login?error=${encodeURIComponent(error_description || oauthError)}`);
    }

    // Validate state
    const stateData = oauthStates.get(state);
    if (!stateData) throw new ApiError('Invalid or expired OAuth state', 400);
    oauthStates.delete(state);

    const { roleHint, redirectUri } = stateData;

    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code, redirectUri);

    // Get user identity from Carerix
    const identity = await getCarerixUserInfo(tokens.accessToken);

    // Sync to local cache
    syncIdentityCache(identity).catch(e => logger.error('Cache sync failed', { e }));

    // Provision Supabase session
    const session = await provisionCarerixSession(identity);

    await writeAuditLog({
      eventType:   'login_carerix',
      actorUserId: session.userId,
      actorRole:   identity.platformRole,
      payload:     { email: identity.email, carerixUserId: identity.carerixUserId },
      ipAddress:   req.ip,
    });

    // Redirect to frontend with session tokens as query params
    // Frontend JS reads these, saves to localStorage, then redirects to dashboard
    const frontendUrl = config.cors.origins[0] || 'https://confair-platform.vercel.app';
    const params = new URLSearchParams({
      access_token:  session.accessToken,
      refresh_token: session.refreshToken,
      expires_at:    String(session.expiresAt),
      user:          JSON.stringify({
        id:              session.userId,
        email:           identity.email,
        displayName:     identity.fullName,
        role:            identity.platformRole,
        authSource:      'carerix',
        carerixUserId:   identity.carerixUserId,
        carerixCompanyId: identity.carerixCompanyId,
      }),
    });

    res.redirect(`${frontendUrl}/auth/callback?${params.toString()}`);
  } catch (err) { next(err); }
});

// ── POST /auth/refresh ────────────────────────────────────────────────────────
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) throw new ApiError('refreshToken is required', 400);
    const { data, error } = await adminSupabase.auth.refreshSession({ refresh_token: refreshToken });
    if (error) throw new ApiError('Invalid or expired refresh token', 401);
    res.json({
      accessToken:  data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresAt:    data.session.expires_at,
    });
  } catch (err) { next(err); }
});

// ── POST /auth/logout ─────────────────────────────────────────────────────────
router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await adminSupabase.auth.admin.signOut(req.token);
    await writeAuditLog({
      eventType:   'logout',
      actorUserId: req.user.id,
      actorRole:   req.user.role,
      ipAddress:   req.ip,
    });
    res.json({ message: 'Logged out successfully' });
  } catch (err) { next(err); }
});

// ── GET /auth/me ──────────────────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  const { id, role, auth_source, display_name, email, carerix_user_id, carerix_company_id } = req.user;
  res.json({ id, role, authSource: auth_source, displayName: display_name, email, carerixUserId: carerix_user_id, carerixCompanyId: carerix_company_id });
});

export default router;
