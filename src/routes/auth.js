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

const parseXml = (xml) => {
  if (typeof xml !== 'string') return xml;
  try { return xmlParser.parse(xml); } catch { return null; }
};
const getId = (obj) => obj?.['@_id'] || obj?.id || obj?._id || null;

// ── Shared Carerix REST login helper ─────────────────────────────────────────
async function loginWithCarerix(username, password) {
  const restBase    = config.carerix.restUrl;
  const restAuth    = Buffer.from(`${config.carerix.restUsername}:${config.carerix.restPassword}`).toString('base64');
  const md5password = crypto.createHash('md5').update(password).digest('hex');

  // Step 1: Authenticate
  let loginXml;
  try {
    const res = await axios.get(`${restBase}CRUser/login-with-encrypted-password`, {
      params:       { u: username, p: md5password, show: 'toEmployee' },
      headers:      { 'Authorization': `Basic ${restAuth}`, 'User-Agent': 'confair-platform/1.0' },
      timeout:      15_000,
      responseType: 'text',
    });
    loginXml = res.data;
  } catch (err) {
    const data   = err.response?.data || '';
    const status = err.response?.status;
    if (typeof data === 'string' && data.includes('AuthorizationFailed')) throw new ApiError('Invalid username or password', 401);
    if (status === 401 || status === 403) throw new ApiError('Invalid username or password', 401);
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

  if (crUser.toEmployee?.CREmployee || crUser.toEmployee?.['@_id']) {
    const emp = crUser.toEmployee?.CREmployee || crUser.toEmployee;
    employeeId = getId(emp);
  }

  // Step 3: If no employee, check CRContact via REST
  if (!employeeId) {
    try {
      const conRes = await axios.get(`${restBase}CRContact`, {
        params:       { qualifier: `toUser.userName = '${username}'`, limit: 1 },
        headers:      { 'Authorization': `Basic ${restAuth}`, 'User-Agent': 'confair-platform/1.0' },
        timeout:      8_000,
        responseType: 'text',
      });
      const cp  = parseXml(conRes.data);
      const arr = cp?.array?.CRContact || cp?.CRContact;
      const con = Array.isArray(arr) ? arr[0] : arr;
      if (con && getId(con)) {
        contactData = con;
        companyId   = getId(con.toCompany?.CRCompany || con.toCompany) || null;
        fullName    = `${con.firstName || ''} ${con.lastName || ''}`.trim() || username;
      }
    } catch (e) {
      logger.info('CRContact lookup skipped', { error: e.message });
    }
  }

  const platformRole = employeeId ? 'placement' : contactData ? 'company_admin' : 'agency_admin';

  return {
    carerixUserId:    String(crUserId),
    carerixCompanyId: companyId ? String(companyId) : null,
    email:            crUser.emailAddress || username,
    fullName,
    platformRole,
    rawPayload: { crUserId, employeeId, companyId },
  };
}

// ── POST /auth/login/agency ───────────────────────────────────────────────────
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

// ── POST /auth/login/carerix ──────────────────────────────────────────────────
router.post('/login/carerix', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) throw new ApiError('Username and password are required', 400);
    const identity = await loginWithCarerix(username, password);
    logger.info('Carerix login', { username, role: identity.platformRole });
    const session = await provisionCarerixSession(identity);
    await writeAuditLog({ eventType: 'login_carerix', actorUserId: session.userId, actorRole: identity.platformRole, payload: { username }, ipAddress: req.ip });
    res.json({ accessToken: session.accessToken, refreshToken: session.refreshToken, expiresAt: session.expiresAt,
      user: { id: session.userId, email: identity.email, displayName: identity.fullName, role: identity.platformRole, authSource: 'carerix', carerixUserId: identity.carerixUserId, carerixCompanyId: identity.carerixCompanyId } });
  } catch (err) { next(err); }
});

// ── POST /auth/forgot-password ────────────────────────────────────────────────
router.post('/forgot-password', async (req, res, next) => {
  try {
    const { username } = req.body;
    if (!username?.trim()) throw new ApiError('Username or email is required', 400);
    // Try Supabase reset first
    const { data: profile } = await adminSupabase.from('user_profiles').select('email').eq('email', username.trim().toLowerCase()).maybeSingle();
    if (profile) {
      await adminSupabase.auth.resetPasswordForEmail(profile.email, { redirectTo: `${config.cors.origins[0]}/reset-password` });
    }
    // Always return success
    res.json({ message: 'If an account exists, a reset link has been sent.' });
  } catch (err) { next(err); }
});

// ── POST /auth/refresh ────────────────────────────────────────────────────────
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) throw new ApiError('refreshToken is required', 400);
    const { data, error } = await adminSupabase.auth.refreshSession({ refresh_token: refreshToken });
    if (error) throw new ApiError('Invalid or expired refresh token', 401);
    res.json({ accessToken: data.session.access_token, refreshToken: data.session.refresh_token, expiresAt: data.session.expires_at });
  } catch (err) { next(err); }
});

// ── POST /auth/logout ─────────────────────────────────────────────────────────
router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await adminSupabase.auth.admin.signOut(req.token);
    res.json({ message: 'Logged out successfully' });
  } catch (err) { next(err); }
});

// ── GET /auth/me ──────────────────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  const { id, role, auth_source, display_name, email, carerix_user_id, carerix_company_id } = req.user;
  res.json({ id, role, authSource: auth_source, displayName: display_name, email, carerixUserId: carerix_user_id, carerixCompanyId: carerix_company_id });
});

export default router;
