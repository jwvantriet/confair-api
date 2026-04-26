import { Router } from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { XMLParser } from 'fast-xml-parser';
import {
  adminSupabase,
  provisionCarerixUser,
  issueSupabaseSession,
} from '../services/supabase.js';
import {
  syncUserCompanyAccessFromCarerix,
  syncPlacementIdentityFromCarerix,
} from '../services/access.js';
import { requireAuth } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';
import { writeAuditLog } from '../utils/audit.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import {
  recordLoginAttempt,
  isUsernameLockedOut,
} from '../services/login_attempts.js';
import {
  signLoginChallenge, verifyLoginChallenge,
  getMfaState, getActiveSecret,
  verifyTotpCode, consumeRecoveryCode,
} from '../services/mfa.js';

const router = Router();
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
const parseXml = (xml) => { try { return xmlParser.parse(xml); } catch { return null; } };
const getId = (obj) => obj?.['@_id'] || obj?.id || obj?._id || null;

// Carerix CRUserRole IDs we map without env config:
//   id=1  → CREmployee linked → placement
//   id=11 → CRCompany linked  → company_admin
// Agency role IDs are configured via env (CARERIX_AGENCY_ADMIN_ROLE_IDS,
// CARERIX_AGENCY_OPERATIONS_ROLE_IDS). Anything else → reject (no defaults).
const ROLE_CONTACT  = 11;
const ROLE_EMPLOYEE = 1;

function mapPlatformRole({ userRoleId, empId, compId }) {
  if (empId  || userRoleId === ROLE_EMPLOYEE) return 'placement';
  if (compId || userRoleId === ROLE_CONTACT)  return 'company_admin';
  if (config.carerix.agencyAdminRoleIds.includes(userRoleId))      return 'agency_admin';
  if (config.carerix.agencyOperationsRoleIds.includes(userRoleId)) return 'agency_operations';
  return null;
}

// Fire-and-forget audit + lockout writes. Both are append-only, best-effort
// telemetry — letting them fall behind the user response saves Supabase
// round-trips on the critical path.
function fireAndForget(label, p) {
  return Promise.resolve(p).catch(err => logger.warn(`${label} failed`, { error: err?.message || String(err) }));
}

export async function loginWithCarerix(username, password, { ipAddress } = {}) {
  const restBase    = config.carerix.restUrl;
  const restAuth    = Buffer.from(`${config.carerix.restUsername}:${config.carerix.restPassword}`).toString('base64');
  const md5password = crypto.createHash('md5').update(password).digest('hex');
  const headers     = { Authorization: `Basic ${restAuth}`, 'User-Agent': 'confair-platform/1.0' };

  let loginXml;
  try {
    const res = await axios.get(`${restBase}CRUser/login-with-encrypted-password`,
      { params: { u: username, p: md5password }, headers, timeout: 15_000, responseType: 'text' });
    loginXml = res.data;
  } catch (err) {
    const d = err.response?.data || '';
    if (typeof d === 'string' && d.includes('AuthorizationFailed')) throw new ApiError('Invalid username or password', 401);
    if ([401, 403].includes(err.response?.status)) throw new ApiError('Invalid username or password', 401);
    throw new ApiError('Could not connect to Carerix', 502);
  }

  if (loginXml?.includes('AuthorizationFailed') || loginXml?.includes('NSException')) {
    throw new ApiError('Invalid username or password', 401);
  }

  const parsed   = parseXml(loginXml);
  const crUser   = parsed?.CRUser || {};
  const crUserId = getId(crUser);
  if (!crUserId) throw new ApiError('Invalid username or password', 401);

  const userRoleId = parseInt(getId(crUser.toUserRole?.CRUserRole || crUser.toUserRole) || '0', 10);
  const empNode  = crUser.toEmployee?.CREmployee || crUser.toEmployee;
  const compNode = crUser.toCompany?.CRCompany   || crUser.toCompany;
  const empId    = getId(empNode);
  const compId   = getId(compNode);
  const fullName = `${crUser.firstName || ''} ${crUser.lastName || ''}`.trim() || username;
  const platformRole = mapPlatformRole({ userRoleId, empId, compId });

  if (!platformRole) {
    logger.warn('Carerix login rejected: no role mapping', { crUserId, userRoleId, empId, compId, username });
    // Persist the diagnostic context to Supabase so admins can find the
    // userRoleId without trawling through Railway logs. Fire-and-forget so a
    // failed audit insert doesn't slow the rejection.
    fireAndForget('login_role_unmapped audit', writeAuditLog({
      eventType: 'login_role_unmapped',
      payload: {
        username,
        crUserId:  String(crUserId),
        userRoleId,
        empId:  empId  ? String(empId)  : null,
        compId: compId ? String(compId) : null,
        email:  crUser.emailAddress || null,
      },
      ipAddress: ipAddress || null,
    }));
    throw new ApiError(
      'Your account is not provisioned for this platform. Please contact your administrator.',
      403,
    );
  }

  logger.info('Carerix login', { crUserId, userRoleId, empId, compId, platformRole, username });

  return {
    carerixUserId:     String(crUserId),
    carerixCompanyId:  compId ? String(compId) : null,
    carerixEmployeeId: empId  ? String(empId)  : null,
    email:             crUser.emailAddress || username,
    fullName,
    platformRole,
    userRoleId,
  };
}

async function refreshUserAccessOnLogin(session, identity) {
  if (!identity?.carerixUserId) return { status: 'skipped', reason: 'no_carerix_user_id' };
  if (identity.platformRole === 'agency_admin' || identity.platformRole === 'agency_operations') {
    return { status: 'skipped', reason: 'agency_role' };
  }

  const { data: profile } = await adminSupabase
    .from('user_profiles')
    .select('access_sync_status, access_sync_last_ok_at')
    .eq('id', session.userId)
    .maybeSingle();
  const hasSyncedBefore = !!profile?.access_sync_last_ok_at;

  let result;
  if (identity.platformRole === 'placement') {
    result = await syncPlacementIdentityFromCarerix(session.userId, identity.carerixUserId);
  } else {
    result = await syncUserCompanyAccessFromCarerix(session.userId, identity.carerixUserId);
  }

  if (result.status === 'synced') {
    if (identity.platformRole !== 'placement') {
      await adminSupabase.rpc('mark_access_sync_outcome', {
        p_user_profile_id: session.userId, p_status: 'synced', p_error: null,
      });
    }
    return result;
  }

  const newStatus  = hasSyncedBefore ? 'stale' : 'failed';
  const errorBlurb = `${result.status}:${result.reason}${result.error ? ` (${result.error})` : ''}`;
  await adminSupabase.rpc('mark_access_sync_outcome', {
    p_user_profile_id: session.userId, p_status: newStatus, p_error: errorBlurb,
  });

  if (!hasSyncedBefore) {
    logger.warn('Login blocked: first-time Carerix sync failed', { userId: session.userId, role: identity.platformRole, ...result });
    throw new ApiError('Could not load your access from Carerix. Please try again in a moment.', 503);
  }

  logger.warn('Carerix sync failed on login — degrading to last-known-good', { userId: session.userId, role: identity.platformRole, ...result });
  return result;
}

function loginResponse(res, session, identity, syncResult) {
  res.json({
    accessToken:  session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt:    session.expiresAt,
    user: {
      id:                session.userId,
      email:             identity.email,
      displayName:       identity.fullName,
      role:              identity.platformRole,
      authSource:        'carerix',
      carerixUserId:     identity.carerixUserId,
      carerixCompanyId:  identity.carerixCompanyId,
      carerixEmployeeId: identity.carerixEmployeeId,
      accessSyncStatus:  syncResult?.status === 'synced' ? 'synced'
                       : syncResult?.status === 'skipped' ? 'skipped' : 'stale',
    },
  });
}

/** Shared login pipeline for /login/agency and /login/carerix. */
async function handleLogin(req, res, next, { username, password }) {
  const ipAddress = req.ip;
  const userAgent = req.headers['user-agent'] || null;

  try {
    if (!username || !password) throw new ApiError('Username and password are required', 400);

    // 1. Per-username lockout (complements per-IP rate limiter).
    const lockout = await isUsernameLockedOut(username);
    if (lockout.locked) {
      res.set('Retry-After', String(lockout.retryAfterSeconds));
      throw new ApiError('Too many failed attempts. Try again later.', 429);
    }

    // 2. Carerix authentication. Failures are recorded + audit-logged.
    let identity;
    try {
      identity = await loginWithCarerix(username, password, { ipAddress });
    } catch (err) {
      // Failure-path telemetry is fire-and-forget too — we want to return the
      // 401/403 to the user as quickly as possible.
      fireAndForget('login_attempts (failed)', recordLoginAttempt({ username, succeeded: false, ipAddress, userAgent }));
      fireAndForget('audit login_failed', writeAuditLog({
        eventType: 'login_failed',
        payload:   { username, reason: err.message, status: err.status || 500 },
        ipAddress,
      }));
      throw err;
    }

    // 3. Provision user (also enforces is_active=false rejection).
    const { userId } = await provisionCarerixUser(identity);

    // 4. MFA gate.
    const mfa = await getMfaState(userId);
    if (mfa.enrolled) {
      const challenge = signLoginChallenge(userId);
      fireAndForget('login_attempts (mfa)', recordLoginAttempt({ username, succeeded: true, ipAddress, userAgent }));
      return res.json({
        mfaRequired: true,
        challenge,
        ttlSeconds: config.mfa.challengeTtlSeconds,
      });
    }
    if (config.mfa.enforceForRoles.includes(identity.platformRole)) {
      fireAndForget('login_attempts (mfa-enforce)', recordLoginAttempt({ username, succeeded: true, ipAddress, userAgent }));
      throw new ApiError('MFA enrollment is required for your role. Please contact your administrator to enrol.', 403);
    }

    // 5. No MFA required — finalise the session.
    const session    = await issueSupabaseSession({ email: identity.email, userId, role: identity.platformRole });
    const syncResult = await refreshUserAccessOnLogin(session, identity);

    // Telemetry off the critical path.
    fireAndForget('login_attempts (success)', recordLoginAttempt({ username, succeeded: true, ipAddress, userAgent }));
    fireAndForget('audit login', writeAuditLog({
      eventType: 'login',
      actorUserId: session.userId,
      actorRole:   identity.platformRole,
      payload:     { username },
      ipAddress,
    }));

    loginResponse(res, session, identity, syncResult);
  } catch (err) { next(err); }
}

router.post('/login/agency', (req, res, next) =>
  handleLogin(req, res, next, { username: req.body?.username || req.body?.email, password: req.body?.password })
);
router.post('/login/carerix', (req, res, next) =>
  handleLogin(req, res, next, { username: req.body?.username, password: req.body?.password })
);

/**
 * Step 2 for MFA users: client sends back the challenge JWT plus the 6-digit
 * code (or a recovery code). On success we issue the real Supabase session.
 */
router.post('/mfa/verify-login', async (req, res, next) => {
  try {
    const { challenge, code, recoveryCode } = req.body || {};
    if (!challenge || (!code && !recoveryCode)) throw new ApiError('challenge and code are required', 400);
    const decoded = verifyLoginChallenge(challenge);
    if (!decoded) throw new ApiError('Invalid or expired login challenge. Sign in again.', 401);

    let ok = false;
    if (code) {
      const secret = await getActiveSecret(decoded.userId);
      ok = !!secret && verifyTotpCode(secret, code);
    } else if (recoveryCode) {
      ok = await consumeRecoveryCode(decoded.userId, recoveryCode);
    }

    if (!ok) {
      fireAndForget('audit mfa_failed', writeAuditLog({
        eventType:   'mfa_failed',
        actorUserId: decoded.userId,
        ipAddress:   req.ip,
        payload:     { mode: code ? 'totp' : 'recovery' },
      }));
      throw new ApiError('Invalid code. Try again.', 401);
    }

    const { data: profile } = await adminSupabase
      .from('user_profiles')
      .select('id, role, email, display_name, carerix_user_id, carerix_company_id, carerix_employee_id')
      .eq('id', decoded.userId)
      .single();
    if (!profile) throw new ApiError('User profile not found', 401);

    const identity = {
      email:             profile.email,
      fullName:          profile.display_name,
      platformRole:      profile.role,
      carerixUserId:     profile.carerix_user_id,
      carerixCompanyId:  profile.carerix_company_id,
      carerixEmployeeId: profile.carerix_employee_id,
    };

    const session    = await issueSupabaseSession({ email: profile.email, userId: profile.id, role: profile.role });
    const syncResult = await refreshUserAccessOnLogin(session, identity);

    fireAndForget('audit mfa_login', writeAuditLog({
      eventType:   'login',
      actorUserId: session.userId,
      actorRole:   identity.platformRole,
      payload:     { mfa: true, mode: code ? 'totp' : 'recovery' },
      ipAddress:   req.ip,
    }));
    loginResponse(res, session, identity, syncResult);
  } catch (err) { next(err); }
});

router.post('/forgot-password', async (req, res, next) => {
  try {
    const { username } = req.body;
    if (!username?.trim()) throw new ApiError('Username or email is required', 400);
    const { data: p } = await adminSupabase.from('user_profiles').select('email').ilike('email', username.trim()).maybeSingle();
    if (p) await adminSupabase.auth.resetPasswordForEmail(p.email, { redirectTo: `${config.cors.origins[0]}/reset-password` });
    res.json({ message: 'If an account exists, a reset link has been sent.' });
  } catch (err) { next(err); }
});

router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) throw new ApiError('refreshToken is required', 400);
    const { data, error } = await adminSupabase.auth.refreshSession({ refresh_token: refreshToken });
    if (error) throw new ApiError('Invalid or expired refresh token', 401);
    res.json({ accessToken: data.session.access_token, refreshToken: data.session.refresh_token, expiresAt: data.session.expires_at });
  } catch (err) { next(err); }
});

router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await adminSupabase.auth.admin.signOut(req.token);
    res.json({ message: 'Logged out' });
  } catch (err) { next(err); }
});

router.get('/me', requireAuth, (req, res) => {
  const {
    id, role, auth_source, display_name, email,
    carerix_user_id, carerix_company_id, carerix_employee_id,
    carerix_function_group_level1_code, carerix_function_group_level1_name,
    access_sync_status,
  } = req.user;
  res.json({
    id, role,
    authSource:                          auth_source,
    displayName:                         display_name,
    email,
    carerixUserId:                       carerix_user_id,
    carerixCompanyId:                    carerix_company_id,
    carerixEmployeeId:                   carerix_employee_id,
    carerixFunctionGroupLevel1Code:      carerix_function_group_level1_code,
    carerixFunctionGroupLevel1Name:      carerix_function_group_level1_name,
    accessSyncStatus:                    access_sync_status,
  });
});

export default router;
