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
  const headers     = { Authorization: `Basic ${restAuth}`, 'User-Agent': 'confair-platform/1.0' };

  // Authenticate via Carerix REST
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

  // Check if existing user profile already has a role — use it
  const { data: existing } = await adminSupabase
    .from('user_profiles')
    .select('role, display_name, carerix_user_id')
    .or(`carerix_user_id.eq.${crUserId},email.ilike.${username}`)
    .maybeSingle();

  if (existing?.role) {
    logger.info('Using existing role', { role: existing.role, crUserId });
    return {
      carerixUserId:    String(crUserId),
      carerixCompanyId: null,
      email:            username,
      fullName:         existing.display_name || username,
      platformRole:     existing.role,
    };
  }

  // New user — default to agency_admin, can be changed by admin
  // Real production users with proper Carerix entities will get correct roles
  // via the permission matrix in future iterations
  logger.info('New user — defaulting to agency_admin', { crUserId, username });

  return {
    carerixUserId:    String(crUserId),
    carerixCompanyId: null,
    email:            username,
    fullName:         username,
    platformRole:     'agency_admin',
  };
}

router.post('/login/agency', async (req, res, next) => {
  try {
    const user = req.body.username || req.body.email;
    if (!user || !req.body.password) throw new ApiError('Username and password are required', 400);
    const identity = await loginWithCarerix(user, req.body.password);
    const session  = await provisionCarerixSession(identity);
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
