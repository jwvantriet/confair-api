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
import { XMLParser } from 'fast-xml-parser';
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

// ── POST /auth/login/agency ── forwards to unified Carerix login ─────────────
// All users now authenticate via Carerix. Agency users are CRUser records
// linked to an office in Carerix. Kept for backwards compatibility.
router.post('/login/agency', (req, res, next) => {
  req.body.username = req.body.username || req.body.email;
  req.url = '/login/carerix';
  router.handle(req, res, next);
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
    const { username, password } = req.body;
    if (!username || !password) throw new ApiError('Username and password are required', 400);

    const restBase    = config.carerix.restUrl;
    const restAuth    = Buffer.from(`${config.carerix.restUsername}:${config.carerix.restPassword}`).toString('base64');
    const md5password = crypto.createHash('md5').update(password).digest('hex');
    const xmlParser   = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

    // Helper: parse Carerix XML response
    const parseXml = (xml) => {
      if (typeof xml !== 'string') return xml; // already parsed
      try { return xmlParser.parse(xml); } catch { return null; }
    };

    // Helper: get attribute id from parsed XML object
    const getId = (obj) => obj?.['@_id'] || obj?.id || obj?._id || null;

    // Step 1: Authenticate via CRUser/login-with-encrypted-password (returns XML)
    let loginXml;
    try {
      const loginRes = await axios.get(`${restBase}CRUser/login-with-encrypted-password`, {
        params: { u: username, p: md5password, show: 'toEmployee' },
        headers: { 'Authorization': `Basic ${restAuth}`, 'User-Agent': 'confair-platform/1.0' },
        timeout: 15_000,
        responseType: 'text',
      });
      loginXml = loginRes.data;
    } catch (err) {
      const data   = err.response?.data || '';
      const status = err.response?.status;
      if (typeof data === 'string' && data.includes('AuthorizationFailed')) {
        throw new ApiError('Invalid username or password', 401);
      }
      if (status === 401 || status === 403) throw new ApiError('Invalid username or password', 401);
      logger.error('Carerix REST login error', { error: err.message, status });
      throw new ApiError('Could not connect to Carerix. Please try again.', 502);
    }

    // Check for auth failure in XML
    if (loginXml?.includes('AuthorizationFailed') || loginXml?.includes('NSException')) {
      throw new ApiError('Invalid username or password', 401);
    }

    // Parse the XML login response
    const parsed   = parseXml(loginXml);
    const crUser   = parsed?.CRUser || {};
    const crUserId = getId(crUser);

    logger.info('Carerix login parsed', { crUserId, hasEmployee: !!crUser.toEmployee });

    if (!crUserId) {
      logger.error('No CRUser id in login response', { loginXml: loginXml?.substring(0, 300) });
      throw new ApiError('Invalid username or password', 401);
    }

    // Step 2: Check if this user is an Employee or Contact
    // Look up CREmployee where toUser._id = crUserId
    let employeeId  = null;
    let contactData = null;
    let companyId   = null;
    let fullName    = username;

    // First check if login response already has toEmployee
    if (crUser.toEmployee?.CREmployee) {
      const emp = crUser.toEmployee.CREmployee;
      employeeId = getId(emp) || crUser.toEmployee.CREmployee?.employeeID;
      logger.info('Employee found in login response', { employeeId });
    }

    if (!employeeId) {
      // Fetch the CRUser directly by ID with toEmployee and toContact expanded
      // This avoids reverse-lookup qualifiers (toUser._id = X) which return 500
      try {
        const userRes = await axios.get(`${restBase}CRUser/${crUserId}`, {
          params: { show: 'toEmployee,toContact,firstName,lastName' },
          headers: { 'Authorization': `Basic ${restAuth}`, 'User-Agent': 'confair-platform/1.0' },
          timeout: 10_000,
          responseType: 'text',
        });
        const userXml    = userRes.data;
        const userParsed = parseXml(userXml);
        const crUserFull = userParsed?.CRUser || {};

        logger.info('CRUser full fetch', {
          id:          crUserFull['@_id'],
          hasEmployee: !!crUserFull.toEmployee,
          hasContact:  !!crUserFull.toContact,
          raw:         userXml?.substring(0, 500),
        });

        // Check toEmployee
        const empNode = crUserFull.toEmployee?.CREmployee || crUserFull.toEmployee;
        if (empNode && getId(empNode)) {
          employeeId = getId(empNode);
          fullName   = `${empNode.firstName || crUserFull.firstName || ''} ${empNode.lastName || crUserFull.lastName || ''}`.trim() || username;
          logger.info('Employee found via CRUser fetch', { employeeId, fullName });
        }

        // Check toContact
        if (!employeeId) {
          const conNode = crUserFull.toContact?.CRContact || crUserFull.toContact;
          if (conNode && getId(conNode)) {
            contactData = conNode;
            // Get company from toCompany
            const compNode = conNode.toCompany?.CRCompany || conNode.toCompany;
            companyId      = getId(compNode) || null;
            fullName       = `${conNode.firstName || crUserFull.firstName || ''} ${conNode.lastName || crUserFull.lastName || ''}`.trim() || username;
            logger.info('Contact found via CRUser fetch', { contactId: getId(conNode), companyId, fullName });
          }
        }

        // Fallback: use name from CRUser itself
        if (!fullName || fullName === username) {
          fullName = `${crUserFull.firstName || ''} ${crUserFull.lastName || ''}`.trim() || username;
        }

      } catch (e) {
        logger.warn('CRUser full fetch failed', { error: e.message, status: e.response?.status });
      }
    }

    // Determine platform role from entity type found in Carerix:
    // CREmployee → placement
    // CRContact  → company_admin
    // CRUser linked to office (no Employee/Contact) → agency_admin
    const platformRole = employeeId ? 'placement'
                       : contactData ? 'company_admin'
                       : 'agency_admin';

    logger.info('Role resolved', { username, crUserId, employeeId, hasContact: !!contactData, companyId, platformRole });

    const identity = {
      carerixUserId:    String(crUserId),
      carerixCompanyId: companyId ? String(companyId) : null,
      carerixContactId: contactData ? String(getId(contactData) || '') : null,
      email:            crUser.emailAddress || username,
      fullName,
      roleInCarerix:    employeeId ? 'Employee' : 'Contact',
      platformRole,
      rawPayload:       { crUserId, employeeId, companyId },
    };

    // Provision Supabase session
    const session = await provisionCarerixSession(identity);

    await writeAuditLog({
      eventType:   'login_carerix',
      actorUserId: session.userId,
      actorRole:   identity.platformRole,
      payload:     { username, carerixUserId: String(crUserId), role: platformRole },
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


// ── POST /auth/forgot-password ────────────────────────────────────────────────
// Sends a password reset link.
// For Agency users: Supabase password reset email.
// For Carerix users: Carerix PASSWORDLINK email template via REST API.
// Always returns success to avoid username enumeration.
router.post('/forgot-password', async (req, res, next) => {
  try {
    const { username } = req.body;
    if (!username?.trim()) throw new ApiError('Username or email is required', 400);

    const email = username.trim().toLowerCase();

    // Try Agency user first (Supabase)
    const { data: profile } = await adminSupabase
      .from('user_profiles')
      .select('id, auth_source, email')
      .or(`email.eq.${email}`)
      .eq('auth_source', 'supabase')
      .maybeSingle();

    if (profile) {
      // Agency user — use Supabase password reset
      await adminSupabase.auth.resetPasswordForEmail(profile.email, {
        redirectTo: `${config.cors.origins[0]}/reset-password`,
      });
      logger.info('Agency password reset sent', { email: profile.email });
    } else {
      // Carerix user — use Carerix PASSWORDLINK via REST API
      const restBase = config.carerix.restUrl;
      const restAuth = Buffer.from(`${config.carerix.restUsername}:${config.carerix.restPassword}`).toString('base64');
      try {
        await axios.get(`${restBase}CRUser/send-password-link`, {
          params: { u: username },
          headers: { 'Authorization': `Basic ${restAuth}`, 'User-Agent': 'confair-platform/1.0' },
          timeout: 10_000,
        });
        logger.info('Carerix password reset sent', { username });
      } catch (e) {
        // Silently ignore — Carerix may not have this endpoint, don't leak info
        logger.warn('Carerix password reset attempt', { error: e.message });
      }
    }

    // Always return success — never reveal if account exists
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
