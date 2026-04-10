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

// Service token cache
let _svcToken = null;
let _svcExp   = 0;

async function getServiceToken() {
  if (_svcToken && Date.now() < _svcExp) return _svcToken;
  const res = await axios.post(`${config.carerix.authUrl}/token`,
    new URLSearchParams({ grant_type: 'client_credentials' }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${Buffer.from(`${config.carerix.clientId}:${config.carerix.clientSecret}`).toString('base64')}` },
      timeout: 10_000,
    });
  _svcToken = res.data.access_token;
  _svcExp   = Date.now() + (res.data.expires_in - 60) * 1000;
  return _svcToken;
}

async function gql(query, variables = {}) {
  const token = await getServiceToken();
  const res   = await axios.post(config.carerix.graphApiUrl, { query, variables }, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'confair-platform/1.0' },
    timeout: 10_000,
  });
  if (res.data.errors) logger.warn('GraphQL errors', { errors: res.data.errors });
  return res.data;
}

async function loginWithCarerix(username, password) {
  const restBase    = config.carerix.restUrl;
  const restAuth    = Buffer.from(`${config.carerix.restUsername}:${config.carerix.restPassword}`).toString('base64');
  const md5password = crypto.createHash('md5').update(password).digest('hex');
  const headers     = { Authorization: `Basic ${restAuth}`, 'User-Agent': 'confair-platform/1.0' };

  // Step 1: Authenticate via REST
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

  const crUserId = getId(parseXml(loginXml)?.CRUser);
  if (!crUserId) throw new ApiError('Invalid username or password', 401);

  logger.info('Carerix authenticated', { crUserId, username });

  // Step 2: Use GraphQL crUser query to get entity type
  // Query CRUser by _id — this is the correct GraphQL approach
  let platformRole = 'agency_admin';
  let fullName     = username;
  let companyId    = null;

  try {
    const data = await gql(`
      query GetUser($id: ID!) {
        crUser(_id: $id) {
          _id
          firstName
          lastName
          toEmployee { _id employeeID }
          toContact { _id toCompany { _id name } }
        }
      }
    `, { id: String(crUserId) });

    const u = data?.data?.crUser;
    logger.info('GraphQL crUser', { 
      id: u?._id, 
      hasEmployee: !!u?.toEmployee?._id,
      hasContact:  !!u?.toContact?._id,
      companyId:   u?.toContact?.toCompany?._id,
    });

    if (u) {
      fullName = `${u.firstName || ''} ${u.lastName || ''}`.trim() || username;

      if (u.toEmployee?._id) {
        platformRole = 'placement';
      } else if (u.toContact?._id) {
        platformRole = 'company_admin';
        companyId    = u.toContact.toCompany?._id || null;
      }
    }
  } catch (e) {
    logger.warn('GraphQL crUser lookup failed', { error: e.message });
  }

  logger.info('Role resolved', { username, crUserId, platformRole, companyId });

  return {
    carerixUserId:    String(crUserId),
    carerixCompanyId: companyId ? String(companyId) : null,
    email:            username,
    fullName,
    platformRole,
  };
}

router.post('/login/agency', async (req, res, next) => {
  try {
    const user = req.body.username || req.body.email;
    const { password } = req.body;
    if (!user || !password) throw new ApiError('Username and password are required', 400);
    const identity = await loginWithCarerix(user, password);
    const session  = await provisionCarerixSession(identity);
    await writeAuditLog({ eventType: 'login', actorUserId: session.userId, actorRole: identity.platformRole, payload: { user }, ipAddress: req.ip });
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
    await writeAuditLog({ eventType: 'login', actorUserId: session.userId, actorRole: identity.platformRole, payload: { username }, ipAddress: req.ip });
    res.json({ accessToken: session.accessToken, refreshToken: session.refreshToken, expiresAt: session.expiresAt,
      user: { id: session.userId, email: identity.email, displayName: identity.fullName, role: identity.platformRole, authSource: 'carerix', carerixUserId: identity.carerixUserId, carerixCompanyId: identity.carerixCompanyId } });
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
  const { id, role, auth_source, display_name, email, carerix_user_id, carerix_company_id } = req.user;
  res.json({ id, role, authSource: auth_source, displayName: display_name, email, carerixUserId: carerix_user_id, carerixCompanyId: carerix_company_id });
});

export default router;
