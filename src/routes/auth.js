import { Router } from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { XMLParser } from 'fast-xml-parser';
import { adminSupabase, provisionCarerixSession } from '../services/supabase.js';
import {
  syncUserCompanyAccessFromCarerix,
  syncPlacementIdentityFromCarerix,
} from '../services/access.js';
import { requireAuth } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';
import { writeAuditLog } from '../utils/audit.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

const router = Router();
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
const parseXml = (xml) => { try { return xmlParser.parse(xml); } catch { return null; } };
const getId = (obj) => obj?.['@_id'] || obj?.id || obj?._id || null;

// Carerix CRUserRole IDs → platform roles
// id=1  → Employee (CREmployee linked) → placement
// id=11 → Contact  (CRCompany linked)  → company_admin
// other → Office/recruiter              → agency_admin
const ROLE_CONTACT  = 11;
const ROLE_EMPLOYEE = 1;

async function loginWithCarerix(username, password) {
  const restBase    = config.carerix.restUrl;
  const restAuth    = Buffer.from(`${config.carerix.restUsername}:${config.carerix.restPassword}`).toString('base64');
  const md5password = crypto.createHash('md5').update(password).digest('hex');
  const headers     = { Authorization: `Basic ${restAuth}`, 'User-Agent': 'confair-platform/1.0' };

  // Call login endpoint WITHOUT any show= parameter
  // This returns the full CRUser XML including toUserRole, toCompany, toEmployee
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

  // Extract role from toUserRole
  const userRoleId = parseInt(getId(crUser.toUserRole?.CRUserRole || crUser.toUserRole) || '0', 10);

  // Extract linked entity
  const empNode  = crUser.toEmployee?.CREmployee || crUser.toEmployee;
  const compNode = crUser.toCompany?.CRCompany   || crUser.toCompany;
  const empId    = getId(empNode);
  const compId   = getId(compNode);

  // Name
  const fullName = `${crUser.firstName || ''} ${crUser.lastName || ''}`.trim() || username;

  // Role mapping
  const platformRole = empId || userRoleId === ROLE_EMPLOYEE ? 'placement'
                     : compId || userRoleId === ROLE_CONTACT  ? 'company_admin'
                     : 'agency_admin';

  logger.info('Carerix login', { crUserId, userRoleId, empId, compId, platformRole, username });

  return {
    carerixUserId:     String(crUserId),
    carerixCompanyId:  compId ? String(compId) : null,
    carerixEmployeeId: empId  ? String(empId)  : null,
    email:             crUser.emailAddress || username,
    fullName,
    platformRole,
  };
}

/**
 * Refresh the user's Carerix-derived state at login.
 *
 * Watertight rules:
 *   - Agency users skip this entirely (they see all data).
 *   - Placements: sync function group level 1 (capture employee_id + fg_level1).
 *   - Company users: sync user_company_access from additionalInfo + linked companies.
 *
 * If the sync aborts (Carerix down, registry unavailable, etc.) AND the user
 * has never had a successful sync before, login is rejected with 503. Users
 * who have synced successfully at least once get graceful degradation:
 *   their access status flips to 'stale' and existing cached rows continue
 *   to apply.
 */
async function refreshUserAccessOnLogin(session, identity) {
  if (!identity?.carerixUserId) return { status: 'skipped', reason: 'no_carerix_user_id' };
  if (identity.platformRole === 'agency_admin' || identity.platformRole === 'agency_operations') {
    return { status: 'skipped', reason: 'agency_role' };
  }

  // Fetch current sync state BEFORE the attempt, so we know whether this is
  // a brand-new user (no prior success) or a returning user.
  const { data: profile } = await adminSupabase
    .from('user_profiles')
    .select('access_sync_status, access_sync_last_ok_at')
    .eq('id', session.userId)
    .maybeSingle();
  const hasSyncedBefore = !!profile?.access_sync_last_ok_at;

  let result;
  if (identity.platformRole === 'placement') {
    if (!identity.carerixEmployeeId) {
      result = { status: 'aborted', reason: 'no_carerix_employee_id' };
    } else {
      result = await syncPlacementIdentityFromCarerix(session.userId, identity.carerixEmployeeId);
    }
  } else {
    // company_admin / company_user / anything else non-agency
    result = await syncUserCompanyAccessFromCarerix(session.userId, identity.carerixUserId);
  }

  if (result.status === 'synced') {
    // Placement sync RPC already marks status='synced'. Company sync RPC
    // only writes user_company_access rows, so we mark status here too.
    if (identity.platformRole !== 'placement') {
      await adminSupabase.rpc('mark_access_sync_outcome', {
        p_user_profile_id: session.userId,
        p_status:          'synced',
        p_error:           null,
      });
    }
    return result;
  }

  // 'unchanged' (no Carerix company links yet) or 'aborted' (transient).
  // Both are non-success: record outcome.
  const newStatus  = hasSyncedBefore ? 'stale' : 'failed';
  const errorBlurb = `${result.status}:${result.reason}${result.error ? ` (${result.error})` : ''}`;
  await adminSupabase.rpc('mark_access_sync_outcome', {
    p_user_profile_id: session.userId,
    p_status:          newStatus,
    p_error:           errorBlurb,
  });

  // Watertight: brand-new user with no successful sync ever → block login.
  // Letting them in would either show a blank UI (placement) or risk the
  // wrong access (company user). Returning 503 lets the client retry.
  if (!hasSyncedBefore) {
    logger.warn('Login blocked: first-time Carerix sync failed', {
      userId: session.userId, role: identity.platformRole, ...result,
    });
    throw new ApiError(
      'Could not load your access from Carerix. Please try again in a moment.',
      503,
    );
  }

  logger.warn('Carerix sync failed on login — degrading to last-known-good', {
    userId: session.userId, role: identity.platformRole, ...result,
  });
  return result;
}

function loginResponse(res, session, identity, syncResult) {
  res.json({
    accessToken:  session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt:    session.expiresAt,
    user: {
      id:                              session.userId,
      email:                           identity.email,
      displayName:                     identity.fullName,
      role:                            identity.platformRole,
      authSource:                      'carerix',
      carerixUserId:                   identity.carerixUserId,
      carerixCompanyId:                identity.carerixCompanyId,
      carerixEmployeeId:               identity.carerixEmployeeId,
      // Frontend can show a "your access info may be out of date" banner
      // when accessSyncStatus is 'stale'.
      accessSyncStatus:                syncResult?.status === 'synced'   ? 'synced'
                                     : syncResult?.status === 'skipped' ? 'skipped'
                                     : 'stale',
    },
  });
}

router.post('/login/agency', async (req, res, next) => {
  try {
    const user = req.body.username || req.body.email;
    if (!user || !req.body.password) throw new ApiError('Username and password are required', 400);
    const identity   = await loginWithCarerix(user, req.body.password);
    const session    = await provisionCarerixSession(identity);
    const syncResult = await refreshUserAccessOnLogin(session, identity);
    await writeAuditLog({ eventType: 'login', actorUserId: session.userId, actorRole: identity.platformRole, payload: { user }, ipAddress: req.ip });
    loginResponse(res, session, identity, syncResult);
  } catch (err) { next(err); }
});

router.post('/login/carerix', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) throw new ApiError('Username and password are required', 400);
    const identity   = await loginWithCarerix(username, password);
    const session    = await provisionCarerixSession(identity);
    const syncResult = await refreshUserAccessOnLogin(session, identity);
    await writeAuditLog({ eventType: 'login', actorUserId: session.userId, actorRole: identity.platformRole, payload: { username }, ipAddress: req.ip });
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
