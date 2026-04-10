import { Router } from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { XMLParser } from 'fast-xml-parser';
import { adminSupabase, provisionCarerixSession } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';
import { writeAuditLog } from '../utils/audit.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

const router = Router();
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
const parseXml = (xml) => { try { return xmlParser.parse(xml); } catch { return null; } };
const getId = (obj) => obj?.['@_id'] || obj?.id || obj?._id || null;

// Carerix userRoleID → platform role mapping
// 11 = Contact (company user)
// Other non-employee values = agency (office/recruiter)
const CONTACT_ROLE_ID = 11;

async function loginWithCarerix(username, password) {
  const restBase    = config.carerix.restUrl;
  const restAuth    = Buffer.from(`${config.carerix.restUsername}:${config.carerix.restPassword}`).toString('base64');
  const md5password = crypto.createHash('md5').update(password).digest('hex');
  const headers     = { 'Authorization': `Basic ${restAuth}`, 'User-Agent': 'confair-platform/1.0' };

  // Step 1: Authenticate — get CRUser id
  let loginXml;
  try {
    const res = await axios.get(`${restBase}CRUser/login-with-encrypted-password`, {
      params: { u: username, p: md5password },
      headers, timeout: 15_000, responseType: 'text',
    });
    loginXml = res.data;
  } catch (err) {
    const data = err.response?.data || '';
    if (typeof data === 'string' && data.includes('AuthorizationFailed')) throw new ApiError('Invalid username or password', 401);
    if (err.response?.status === 401 || err.response?.status === 403) throw new ApiError('Invalid username or password', 401);
    throw new ApiError('Could not connect to Carerix', 502);
  }

  if (loginXml?.includes('AuthorizationFailed') || loginXml?.includes('NSException')) {
    throw new ApiError('Invalid username or password', 401);
  }

  const loginParsed = parseXml(loginXml);
  const loginUser   = loginParsed?.CRUser || {};
  const crUserId    = getId(loginUser);
  if (!crUserId) throw new ApiError('Invalid username or password', 401);

  logger.info('Carerix login success', { crUserId, username });

  // Step 2: Fetch full CRUser record without show= to get all scalar fields
  // (show= only expands relationships; without it we get all scalars including userRoleID)
  let userRoleID  = null;
  let fullName    = username;
  let employeeId  = null;
  let companyId   = null;

  try {
    const userRes  = await axios.get(`${restBase}CRUser/${crUserId}`, {
      headers, timeout: 8_000, responseType: 'text',
    });
    const userParsed = parseXml(userRes.data);
    const crUser     = userParsed?.CRUser || {};
    userRoleID       = parseInt(crUser.userRoleID || '0', 10);
    fullName         = `${crUser.firstName || ''} ${crUser.lastName || ''}`.trim() || username;
    logger.info('CRUser full record', { crUserId, userRoleID, fullName, keys: Object.keys(crUser) });
  } catch (e) {
    logger.warn('CRUser fetch failed', { error: e.message });
  }

  // Step 3: If employee type, get employee ID
  if (userRoleID && userRoleID !== CONTACT_ROLE_ID) {
    try {
      const empRes = await axios.get(`${restBase}CREmployee`, {
        params: { qualifier: `toUser.userID = ${crUserId}`, limit: 1 },
        headers, timeout: 6_000, responseType: 'text',
      });
      const ep  = parseXml(empRes.data);
      const arr = ep?.array?.CREmployee || ep?.CREmployee;
      const emp = Array.isArray(arr) ? arr[0] : arr;
      if (emp && getId(emp)) {
        employeeId = getId(emp);
        fullName   = `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || fullName;
      }
    } catch (e) {
      logger.info('Employee lookup skipped', { error: e.message });
    }
  }

  // Step 4: If contact type, get company
  if (userRoleID === CONTACT_ROLE_ID) {
    try {
      const conRes = await axios.get(`${restBase}CRContact`, {
        params: { qualifier: `emailAddress = '${username}'`, limit: 1, show: 'toCompany' },
        headers, timeout: 6_000, responseType: 'text',
      });
      const cp  = parseXml(conRes.data);
      const arr = cp?.array?.CRContact || cp?.CRContact;
      const con = Array.isArray(arr) ? arr[0] : arr;
      if (con) {
        const comp = con.toCompany?.CRCompany || con.toCompany;
        companyId  = getId(comp) || null;
        fullName   = `${con.firstName || ''} ${con.lastName || ''}`.trim() || fullName;
      }
    } catch (e) {
      logger.info('Contact company lookup skipped', { error: e.message });
    }
  }

  // Role mapping:
  // employeeId present → placement
  // userRoleID=11 (Contact) → company_admin  
  // anything else → agency_admin
  const platformRole = employeeId ? 'placement'
                     : userRoleID === CONTACT_ROLE_ID ? 'company_admin'
                     : 'agency_admin';

  logger.info('Role resolved', { username, crUserId, userRoleID, platformRole, employeeId, companyId });

  return {
    carerixUserId:    String(crUserId),
    carerixCompanyId: companyId ? String(companyId) : null,
    email:            username,
    fullName,
    platformRole,
    rawPayload: { crUserId, userRoleID, employeeId, companyId },
  };
}

router.post('/login/agency', async (req, res, next) => {
  try {
    const { email, password, username } = req.body;
    const user = username || email;
    if (!user || !password) throw new ApiError('Username and password are required', 400);
    const identity = await loginWithCarerix(user, password);
    const session  = await provisionCarerixSession(identity);
    await writeAuditLog({ eventType: 'login_agency', actorUserId: session.userId, actorRole: identity.platformRole, payload: { user }, ipAddress: req.ip });
    res.json({ accessToken: session.accessToken, refreshToken: session.refreshToken, expiresAt: session.expiresAt,
      user: { id: session.userId, email: identity.email, displayName: identity.fullName, role: identity.platformRole, authSource: 'carerix', carerixUserId: identity.carerixUserId, carerixCompanyId: identity.carerixCompanyId } });
  } catch (err) { next(err); }
});

router.post('/login/carerix', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) throw new ApiError('Username and password are required', 400);
    const identity = await loginWithCarerix(username, password);
    const session  = await provisionCarerixSession(identity);
    await writeAuditLog({ eventType: 'login_carerix', actorUserId: session.userId, actorRole: identity.platformRole, payload: { username }, ipAddress: req.ip });
    res.json({ accessToken: session.accessToken, refreshToken: session.refreshToken, expiresAt: session.expiresAt,
      user: { id: session.userId, email: identity.email, displayName: identity.fullName, role: identity.platformRole, authSource: 'carerix', carerixUserId: identity.carerixUserId, carerixCompanyId: identity.carerixCompanyId } });
  } catch (err) { next(err); }
});

router.post('/forgot-password', async (req, res, next) => {
  try {
    const { username } = req.body;
    if (!username?.trim()) throw new ApiError('Username or email is required', 400);
    const { data: profile } = await adminSupabase.from('user_profiles').select('email').ilike('email', username.trim()).maybeSingle();
    if (profile) await adminSupabase.auth.resetPasswordForEmail(profile.email, { redirectTo: `${config.cors.origins[0]}/reset-password` });
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
    res.json({ message: 'Logged out successfully' });
  } catch (err) { next(err); }
});

router.get('/me', requireAuth, (req, res) => {
  const { id, role, auth_source, display_name, email, carerix_user_id, carerix_company_id } = req.user;
  res.json({ id, role, authSource: auth_source, displayName: display_name, email, carerixUserId: carerix_user_id, carerixCompanyId: carerix_company_id });
});

export default router;
