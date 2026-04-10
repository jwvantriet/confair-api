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

// Service token cache for GraphQL calls
let _svcToken = null;
let _svcTokenExp = 0;

async function getServiceToken() {
  if (_svcToken && Date.now() < _svcTokenExp) return _svcToken;
  const res = await axios.post(`${config.carerix.authUrl}/token`,
    new URLSearchParams({ grant_type: 'client_credentials' }), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${Buffer.from(`${config.carerix.clientId}:${config.carerix.clientSecret}`).toString('base64')}`,
      }, timeout: 10_000,
    }
  );
  _svcToken    = res.data.access_token;
  _svcTokenExp = Date.now() + (res.data.expires_in - 60) * 1000;
  return _svcToken;
}

async function graphql(query, variables = {}) {
  const token = await getServiceToken();
  const res = await axios.post(config.carerix.graphApiUrl, { query, variables }, {
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'confair-platform/1.0' },
    timeout: 10_000,
  });
  return res.data;
}

async function loginWithCarerix(username, password) {
  const restBase    = config.carerix.restUrl;
  const restAuth    = Buffer.from(`${config.carerix.restUsername}:${config.carerix.restPassword}`).toString('base64');
  const md5password = crypto.createHash('md5').update(password).digest('hex');
  const headers     = { 'Authorization': `Basic ${restAuth}`, 'User-Agent': 'confair-platform/1.0' };

  // Step 1: Authenticate via Carerix REST
  let loginXml;
  try {
    const res = await axios.get(`${restBase}CRUser/login-with-encrypted-password`, {
      params: { u: username, p: md5password }, headers, timeout: 15_000, responseType: 'text',
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

  const parsed   = parseXml(loginXml);
  const crUser   = parsed?.CRUser || {};
  const crUserId = getId(crUser);
  if (!crUserId) throw new ApiError('Invalid username or password', 401);

  logger.info('Carerix login success', { crUserId, username });

  // Step 2: Use GraphQL (service token) to determine entity type
  // Check if CREmployee exists for this user
  let platformRole  = 'agency_admin';
  let fullName      = username;
  let companyId     = null;

  try {
    const [empData, conData] = await Promise.allSettled([
      graphql(`{ crEmployeePage(qualifier: "toUser.userID = ${crUserId}", pageable: {page:0,size:1}) { totalElements items { _id firstName lastName } } }`),
      graphql(`{ crContactPage(qualifier: "toUser.userID = ${crUserId}", pageable: {page:0,size:1}) { totalElements items { _id firstName lastName toCompany { _id name } } } }`),
    ]);

    const emp = empData.status === 'fulfilled' ? empData.value?.data?.crEmployeePage?.items?.[0] : null;
    const con = conData.status === 'fulfilled' ? conData.value?.data?.crContactPage?.items?.[0] : null;

    logger.info('GraphQL entity lookup', {
      empTotal: empData.status === 'fulfilled' ? empData.value?.data?.crEmployeePage?.totalElements : 'error',
      conTotal: conData.status === 'fulfilled' ? conData.value?.data?.crContactPage?.totalElements : 'error',
      empError: empData.reason?.message,
      conError: conData.reason?.message,
    });

    if (emp?._id) {
      platformRole = 'placement';
      fullName     = `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || username;
    } else if (con?._id) {
      platformRole = 'company_admin';
      companyId    = con.toCompany?._id || null;
      fullName     = `${con.firstName || ''} ${con.lastName || ''}`.trim() || username;
    }
  } catch (e) {
    logger.warn('GraphQL entity lookup failed', { error: e.message });
  }

  logger.info('Role resolved', { username, crUserId, platformRole, companyId });

  return {
    carerixUserId:    String(crUserId),
    carerixCompanyId: companyId ? String(companyId) : null,
    email:            crUser.emailAddress || username,
    fullName,
    platformRole,
    rawPayload: { crUserId, companyId },
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
