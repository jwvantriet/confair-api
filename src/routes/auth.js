import { Router } from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { XMLParser } from 'fast-xml-parser';
import { adminSupabase, provisionCarerixSession } from '../services/supabase.js';
import {
  syncUserCompanyAccessFromCarerix,
  syncPlacementIdentityFromCarerix,
} from '../services/access.js';
import {
  queryGraphQL,
  getCarerixCheckboxRegistry,
  fetchPlacementIdentityByCrUserId,
} from '../services/carerix.js';
import { requireAuth, requireAgency } from '../middleware/auth.js';
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

  // Extract linked entity (may be missing in the XML for some Carerix configs;
  // for placements we look up the employee via GraphQL later).
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
    userRoleId,
  };
}

/**
 * Refresh the user's Carerix-derived state at login.
 *
 * Watertight rules:
 *   - Agency users skip this entirely (they see all data).
 *   - Placements: sync function group level 1 via CRUser.userID GraphQL lookup.
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
    // Look up via CRUser.userID; the XML login response doesn't always
    // include toEmployee, but the GraphQL CRUser→toEmployee path does.
    result = await syncPlacementIdentityFromCarerix(session.userId, identity.carerixUserId);
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

// ── Diagnostic login probe ───────────────────────────────────────────────────
//
// POST /auth/probe
//
// Agency-only. Runs the FULL Carerix login + identity lookup against a
// supplied set of credentials, but creates no session and writes nothing to
// user_profiles or user_company_access. Returns a rich diagnostic blob with
// per-phase timings, decoded function groups, linked companies (resolved vs
// unimported), and warnings flagging any misconfiguration.
//
// Intended use: a config-page tool that lets agency admins paste a user's
// credentials and immediately see what that user would see if they logged
// in. Useful for validating Carerix-side checkbox / function-group setup
// without touching the user's real session.

/**
 * Probes a company user's access state by querying CRUser.additionalInfo,
 * CRUserCompany links, and the checkbox registry — same data sources as
 * the real sync, but read-only and with extra detail in the response.
 */
async function probeCompanyAccess(crUserId) {
  const out = {
    registryAvailable:     false,
    registryEntries:       0,
    additionalInfoKeysSet: [],
    decodedFunctionGroups: [],
    linkedCompanies:       [],
    unknownCompanies:      [],
  };
  const crUserIdNum = Number(crUserId);
  if (!Number.isFinite(crUserIdNum)) return out;

  let userResp, linksResp, registry;
  try {
    [userResp, linksResp, registry] = await Promise.all([
      queryGraphQL(`
        query CRUser($qualifier: String) {
          crUserPage(qualifier: $qualifier, pageable: { page: 0, size: 1 }) {
            items { _id userID additionalInfo }
          }
        }
      `, { qualifier: `userID == ${crUserIdNum}` }),
      queryGraphQL(`
        query UserCompanies($qualifier: String, $pageable: Pageable) {
          crUserCompanyPage(qualifier: $qualifier, pageable: $pageable) {
            totalElements
            items { _id toCompany { _id companyID name } }
          }
        }
      `, {
        qualifier: `toUser.userID == ${crUserIdNum}`,
        pageable:  { page: 0, size: 100 },
      }),
      getCarerixCheckboxRegistry(),
    ]);
  } catch (err) {
    out.error = `carerix_unreachable: ${err.message}`;
    return out;
  }

  out.registryAvailable = registry !== null;
  out.registryEntries   = registry ? Object.keys(registry).length : 0;

  const additionalInfo = userResp?.data?.crUserPage?.items?.[0]?.additionalInfo || {};
  if (registry) {
    for (const [key, value] of Object.entries(additionalInfo)) {
      if (String(value).trim() !== '1') continue;
      const rawKey = key.startsWith('_') ? key.slice(1) : key;
      out.additionalInfoKeysSet.push(rawKey);
      const code = registry[rawKey];
      if (code) out.decodedFunctionGroups.push(code);
    }
  }

  const links = linksResp?.data?.crUserCompanyPage?.items || [];
  const carerixCompanies = links
    .map(l => l?.toCompany)
    .filter(c => c?.companyID != null);
  const carerixCompanyIds = Array.from(new Set(carerixCompanies.map(c => String(c.companyID))));

  // Resolve to platform companies
  let resolvedRows = [];
  if (carerixCompanyIds.length) {
    const { data } = await adminSupabase
      .from('companies')
      .select('id, name, carerix_company_id')
      .in('carerix_company_id', carerixCompanyIds);
    resolvedRows = data || [];
  }
  const resolvedMap = new Map(resolvedRows.map(r => [r.carerix_company_id, r]));

  out.linkedCompanies = carerixCompanyIds.map(cid => {
    const carerixSrc = carerixCompanies.find(c => String(c.companyID) === cid);
    const platform   = resolvedMap.get(cid);
    return {
      carerixCompanyId:    cid,
      nameInCarerix:       carerixSrc?.name || null,
      platformCompanyId:   platform?.id   || null,
      platformCompanyName: platform?.name || null,
      imported:            !!platform,
    };
  });
  out.unknownCompanies = out.linkedCompanies.filter(c => !c.imported).map(c => c.carerixCompanyId);

  return out;
}

/**
 * Run the full login probe for a given (username, password). Catches all
 * errors and reports them; never throws. Always returns a structured result
 * suitable for showing in a config-page UI.
 */
async function runLoginProbe(username, password) {
  const tStart  = Date.now();
  const timings = {};
  const warnings = [];

  // ── Phase 1: Carerix REST login ─────────────────────────────────────────
  const t1 = Date.now();
  let identity;
  try {
    identity = await loginWithCarerix(username, password);
  } catch (err) {
    timings.carerixRestLogin = Date.now() - t1;
    timings.total            = Date.now() - tStart;
    return {
      approved: false,
      error: {
        status:  err.statusCode || err.status || 500,
        message: err.message || 'Login failed',
      },
      timings,
    };
  }
  timings.carerixRestLogin = Date.now() - t1;

  const result = {
    approved:          true,
    platformRole:      identity.platformRole,
    email:             identity.email,
    fullName:          identity.fullName,
    carerixUserId:     identity.carerixUserId,
    carerixCompanyId:  identity.carerixCompanyId,
    carerixEmployeeId: identity.carerixEmployeeId,
    userRoleIdInCarerix: identity.userRoleId,
    placement:         null,
    company:           null,
    agency:            null,
    warnings,
  };

  // ── Phase 2: role-specific lookups ──────────────────────────────────────
  if (identity.platformRole === 'placement') {
    const t2 = Date.now();
    const fg = await fetchPlacementIdentityByCrUserId(identity.carerixUserId);
    timings.placementLookup = Date.now() - t2;
    if (!fg) {
      warnings.push('No CREmployee linked to this CRUser; placement-scoped queries will return nothing.');
      result.placement = { found: false };
    } else {
      result.placement = {
        found:                true,
        carerixEmployeeId:    fg.employeeID,
        functionGroupLevel1:  {
          id:   fg.fgLevel1Id,
          code: fg.fgLevel1Code,
          name: fg.fgLevel1Name,
        },
      };
      if (!fg.fgLevel1Code) {
        warnings.push('Placement has no toFunction1Level1Node set in Carerix — function-group linking will not work for them.');
      }
    }
  } else if (identity.platformRole === 'agency_admin' || identity.platformRole === 'agency_operations') {
    result.agency = {
      note: 'Agency role — will see all companies and placements (no per-company access scoping).',
    };
  } else {
    // company_admin / company_user / other non-agency
    const t2 = Date.now();
    const probe = await probeCompanyAccess(identity.carerixUserId);
    timings.companyAccessLookup = Date.now() - t2;
    result.company = probe;

    if (probe.error)                                              warnings.push(probe.error);
    if (!probe.registryAvailable)                                 warnings.push('Carerix checkbox registry could not be loaded — function groups cannot be decoded right now.');
    if (probe.registryAvailable && probe.registryEntries === 0)   warnings.push('Carerix checkbox registry is empty — there are no Attribute-contact CRDataNodes with tag=checkboxType. Function groups cannot be decoded.');
    if (probe.linkedCompanies.length === 0)                       warnings.push('No CRUserCompany links — this user will see no companies after login.');
    if (probe.unknownCompanies.length > 0)                        warnings.push(`${probe.unknownCompanies.length} Carerix company(s) linked to this user are NOT yet imported into the platform companies table; they will be invisible after login. Run syncCarerixCompany for: ${probe.unknownCompanies.join(', ')}`);
    if (probe.registryAvailable && probe.decodedFunctionGroups.length === 0 && probe.linkedCompanies.length > 0) {
      warnings.push('No function-group checkboxes ticked on this CRUser — the user will be granted zero function groups (explicit deny) on each linked company.');
    }
  }

  timings.total = Date.now() - tStart;
  return { ...result, timings };
}

router.post('/probe', requireAuth, requireAgency, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) throw new ApiError('username and password are required', 400);

    const probeResult = await runLoginProbe(username, password);

    // Audit: record who probed whom (not the password). Helpful when
    // multiple agency admins are debugging at once.
    await writeAuditLog({
      eventType:    'login_probe',
      actorUserId:  req.user.id,
      actorRole:    req.user.role,
      payload: {
        probedUsername: username,
        approved:       probeResult.approved,
        role:           probeResult.platformRole || null,
        warnings:       probeResult.warnings?.length || 0,
        totalMs:        probeResult.timings?.total ?? null,
      },
      ipAddress: req.ip,
    });

    res.json(probeResult);
  } catch (err) { next(err); }
});

export default router;
