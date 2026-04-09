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
import axios from 'axios';
import { z } from 'zod';
import crypto from 'crypto';
import { adminSupabase, provisionCarerixSession } from '../services/supabase.js';
import {
  getCarerixUserInfo,
  syncIdentityCache,
} from '../services/carerix.js';
import { requireAuth } from '../middleware/auth.js';
import { ApiError }    from '../middleware/errorHandler.js';
import { writeAuditLog } from '../utils/audit.js';
import { logger }      from '../utils/logger.js';
import { config }      from '../config.js';

const router = Router();

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

// ── POST /auth/login/carerix — direct credential login (ROPC flow) ────────────
// User enters their Carerix email/password on our login page.
// We send credentials directly to Carerix token endpoint (password grant).
// No redirects — same UX as Agency login.
router.post('/login/carerix', async (req, res, next) => {
  try {
    const { email, password, roleHint } = req.body;
    if (!email || !password) throw new ApiError('Email and password are required', 400);

    // Use Resource Owner Password Credentials (ROPC) grant
    const tokenRes = await axios.post(config.carerix.tokenUrl,
      new URLSearchParams({
        grant_type: 'password',
        client_id:  config.carerix.clientId,
        client_secret: config.carerix.clientSecret,
        username:   email,
        password:   password,
        scope:      'openid profile email',
      }), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent':   'confair-platform/1.0',
        },
        timeout: 10_000,
      }
    ).catch(err => {
      const msg = err.response?.data?.error_description || err.response?.data?.error || err.message;
      throw new ApiError(`Invalid Carerix credentials: ${msg}`, 401);
    });

    const { access_token } = tokenRes.data;
    if (!access_token) throw new ApiError('Carerix did not return an access token', 502);

    // Get user identity from Carerix userinfo endpoint
    const identity = await getCarerixUserInfo(access_token);

    // Optional role hint validation
    if (roleHint) {
      const isPlacement = identity.platformRole === 'placement';
      const isCompany   = ['company_admin','company_user'].includes(identity.platformRole);
      if (roleHint === 'placement' && !isPlacement) throw new ApiError('This account is not a Placement', 403);
      if (roleHint === 'company'   && !isCompany)   throw new ApiError('This account is not a Company user', 403);
    }

    // Sync to local cache
    syncIdentityCache(identity).catch(e => logger.error('Cache sync failed', { e }));

    // Provision Supabase session
    const session = await provisionCarerixSession(identity);

    await writeAuditLog({
      eventType:   'login_carerix',
      actorUserId: session.userId,
      actorRole:   identity.platformRole,
      payload:     { email, carerixUserId: identity.carerixUserId },
      ipAddress:   req.ip,
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

// ── GET /auth/carerix/callback — OAuth2 callback ──────────────────────────────
router.get('/carerix/callback', async (req, res, next) => {
  try {
    const { code, state, error: oauthError, error_description } = req.query;

    if (oauthError) {
      logger.warn('Carerix OAuth error', { error: oauthError, description: error_description });
      const frontendUrl = config.cors.origins[0] || 'https://confair-platform.vercel.app';
      return res.redirect(`${frontendUrl}/login?error=${encodeURIComponent(error_description || oauthError)}`);
    }

    // Decode stateless state (base64 encoded JSON)
    let stateData;
    try {
      stateData = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
    } catch {
      throw new ApiError('Invalid OAuth state format', 400);
    }
    if (!stateData.exp || Date.now() > stateData.exp) {
      throw new ApiError('OAuth state has expired. Please try logging in again.', 400);
    }
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
