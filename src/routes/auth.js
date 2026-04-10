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

async function loginWithCarerix(username, password) {
  const restBase    = config.carerix.restUrl;
  const restAuth    = Buffer.from(`${config.carerix.restUsername}:${config.carerix.restPassword}`).toString('base64');
  const md5password = crypto.createHash('md5').update(password).digest('hex');
  const headers     = { 'Authorization': `Basic ${restAuth}`, 'User-Agent': 'confair-platform/1.0' };

  // Step 1: Authenticate
  let loginXml;
  try {
    const res = await axios.get(`${restBase}CRUser/login-with-encrypted-password`, {
      params: { u: username, p: md5password, show: 'toEmployee' },
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

  const parsed   = parseXml(loginXml);
  const crUser   = parsed?.CRUser || {};
  const crUserId = getId(crUser);
  if (!crUserId) throw new ApiError('Invalid username or password', 401);

  // Step 2: Check toEmployee in login response
  let employeeId  = null;
  let contactData = null;
  let companyId   = null;
  let fullName    = username;

  const empNode = crUser.toEmployee?.CREmployee || crUser.toEmployee;
  if (empNode && getId(empNode)) {
    employeeId = getId(empNode);
    fullName = `${empNode.firstName || ''} ${empNode.lastName || ''}`.trim() || username;
    logger.info('Employee in login response', { employeeId });
  }

  // Step 3: Try to find CRContact if not an employee
  if (!employeeId) {
    const queries = [
      `toUser._id = ${crUserId}`,
      `toUser.userID = ${crUserId}`,
      `emailAddress = '${username}'`,
      `emailAddressBusiness = '${username}'`,
    ];
    for (const qualifier of queries) {
      try {
        const res = await axios.get(`${restBase}CRContact`, {
          params: { qualifier, limit: 1 },
          headers, timeout: 6_000, responseType: 'text',
        });
        const cp  = parseXml(res.data);
        const arr = cp?.array?.CRContact || cp?.CRContact;
        const con = Array.isArray(arr) ? arr[0] : arr;
        if (con && getId(con)) {
          contactData = con;
          const comp  = con.toCompany?.CRCompany || con.toCompany;
          companyId   = getId(comp) || null;
          fullName    = `${con.firstName || ''} ${con.lastName || ''}`.trim() || username;
          logger.info('Contact found', { qualifier, contactId: getId(con), companyId });
          break;
        }
        logger.info('No contact for qualifier', { qualifier });
      } catch (e) {
        logger.info('Contact query error', { qualifier, status: e.response?.status });
      }
    }
  }

  const platformRole = employeeId ? 'placement' : contactData ? 'company_admin' : 'agency_admin';
  logger.info('Role resolved', { username, crUserId, platformRole });

  return {
    carerixUserId:    String(crUserId),
    carerixCompanyId: companyId ? String(companyId) : null,
    email:            crUser.emailAddress || username,
    fullName,
    platformRole,
    rawPayload: { crUserId, employeeId, companyId },
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
