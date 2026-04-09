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

// ── POST /auth/login/carerix — Carerix REST API login ────────────────────────
// Uses the Carerix legacy REST API (api.carerix.com) with encrypted password.
// Flow:
//   1. MD5 hash the user's password
//   2. Call CRUser/login-with-encrypted-password with username + MD5 hash
//   3. On success, fetch CREmployee or CRContact to determine role
//   4. Provision Supabase session
router.post('/login/carerix', async (req, res, next) => {
  try {
    const { username, password, roleHint } = req.body;
    if (!username || !password) throw new ApiError('Username and password are required', 400);

    const restBase    = config.carerix.restUrl;
    const restAuth    = Buffer.from(`${config.carerix.restUsername}:${config.carerix.restPassword}`).toString('base64');
    const md5password = crypto.createHash('md5').update(password).digest('hex');

    // Step 1: Authenticate via CRUser/login-with-encrypted-password
    let loginRes;
    try {
      loginRes = await axios.get(`${restBase}CRUser/login-with-encrypted-password`, {
        params: { u: username, p: md5password, show: 'toEmployee' },
        headers: {
          'Authorization': `Basic ${restAuth}`,
          'Accept':        'application/json',
          'User-Agent':    'confair-platform/1.0',
        },
        timeout: 15_000,
      });
    } catch (err) {
      const status = err.response?.status;
      if (status === 401 || status === 403) {
        throw new ApiError('Invalid username or password', 401);
      }
      logger.error('Carerix REST login error', { error: err.message, status });
      throw new ApiError('Could not connect to Carerix. Please try again.', 502);
    }

    const userData = loginRes.data;
    if (!userData || userData.errorCode) {
      throw new ApiError('Invalid username or password', 401);
    }

    // Log raw response so we can see the field structure
    logger.info('Carerix REST raw response', { 
      keys: Object.keys(userData),
      _id: userData._id,
      userID: userData.userID,
      scrambledUserID: userData.scrambledUserID,
      employeeID: userData.employeeID,
      toEmployee: userData.toEmployee,
      firstName: userData.firstName,
      lastName: userData.lastName,
    });

    // Step 2: Determine role — check if they have an Employee or Contact record
    // Carerix REST returns _id as the CRUser ID
    const carerixUserId  = String(userData._id || userData.userID || '');
    const employeeData   = userData.toEmployee;
    // Employee link can be nested or flat depending on what Carerix returns
    const employeeId     = employeeData?._id || employeeData?.employeeID || null;
    // Build full name from employee record first, then user record
    const firstName = employeeData?.firstName || userData.firstName || '';
    const lastName  = employeeData?.lastName  || userData.lastName  || '';
    const fullName  = `${firstName} ${lastName}`.trim() || username;

    // Step 2: Determine role by looking up what entity is linked to this CRUser
    // Carerix uses 'userName' (not email) as the login field on CRUser records.
    // We look up the CRUser by userName to find their linked Employee or Contact.
    let contactData = null;
    let companyId   = null;

    // The login response toEmployee tells us if this user is an Employee
    // If not, look up CRUser by userName to find their Contact link
    if (!employeeId) {
      try {
        // Look up CRUser by userName to find linked contact
        const userRes = await axios.get(`${restBase}CRUser`, {
          params: {
            qualifier: `userName = '${username}'`,
            show:      '_id,userName,toEmployee._id,toEmployee.employeeID,toContact._id,toContact.toCompany._id,toContact.toCompany.name',
            limit:     1,
          },
          headers: {
            'Authorization': `Basic ${restAuth}`,
            'Accept':        'application/json',
            'User-Agent':    'confair-platform/1.0',
          },
          timeout: 10_000,
        });
        const data  = userRes.data;
        const users = data?.items || (Array.isArray(data) ? data : (data?._id ? [data] : []));
        if (users.length > 0) {
          const crUser = users[0];
          logger.info('CRUser lookup result', {
            userName: crUser.userName,
            hasEmployee: !!crUser.toEmployee,
            hasContact:  !!crUser.toContact,
            companyId:   crUser.toContact?.toCompany?._id,
          });
          if (crUser.toContact?._id) {
            contactData = crUser.toContact;
            companyId   = crUser.toContact.toCompany?._id || null;
          } else if (crUser.toEmployee?._id) {
            // Employee found via CRUser lookup — override
            logger.info('Employee found via CRUser lookup', { employeeId: crUser.toEmployee._id });
          }
        }
      } catch (e) {
        logger.warn('CRUser lookup failed', { error: e.message, status: e.response?.status });
      }
    }

    // Determine platform role
    const platformRole = employeeId ? 'placement' : (contactData ? 'company_admin' : 'placement');
    logger.info('Role resolved', { username, employeeId, hasContact: !!contactData, companyId, platformRole });

    // Validate role hint
    if (roleHint) {
      const isPlacement = platformRole === 'placement';
      const isCompany   = platformRole.startsWith('company');
      if (roleHint === 'placement' && !isPlacement) throw new ApiError('This account is not registered as a Placement', 403);
      if (roleHint === 'company'   && !isCompany)   throw new ApiError('This account is not registered as a Company user', 403);
    }

    const identity = {
      carerixUserId:    carerixUserId,
      carerixCompanyId: companyId ? String(companyId) : null,
      carerixContactId: contactData?._id ? String(contactData._id) : null,
      email:            userData.emailAddress || username,
      fullName:         fullName,
      roleInCarerix:    employeeId ? 'Employee' : 'Contact',
      platformRole,
      rawPayload:       userData,
    };

    // Provision Supabase session
    const session = await provisionCarerixSession(identity);

    await writeAuditLog({
      eventType:   'login_carerix',
      actorUserId: session.userId,
      actorRole:   identity.platformRole,
      payload:     { username, carerixUserId, role: platformRole },
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
