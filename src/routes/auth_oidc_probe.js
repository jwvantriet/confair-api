/**
 * Diagnostic endpoint to test Carerix OAuth ROPC login without changing the
 * live login route. Agency-only.
 *
 * Usage (from a logged-in agency account):
 *   curl -X POST $API/auth/oidc-probe \
 *     -H 'Authorization: Bearer <agency-access-token>' \
 *     -H 'Content-Type: application/json' \
 *     -d '{"username":"crew@confair.com","password":"…"}'
 *
 * Returns success/failure + per-step timing + the decoded ID-token claims.
 * Use the claims to decide which fields we still need to fetch via GraphQL
 * (role, employee link, company link).
 */

import { Router } from 'express';
import { requireAuth, requireAgency } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';
import { writeAuditLog } from '../utils/audit.js';
import { loginWithCarerixOAuth } from '../services/carerix_auth.js';

const router = Router();

router.post('/oidc-probe', requireAuth, requireAgency, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) throw new ApiError('username and password are required', 400);

    const t0 = Date.now();
    let probeResult;
    try {
      const { claims, tokenResponse } = await loginWithCarerixOAuth(username, password);
      const tokenMs = Date.now() - t0;

      probeResult = {
        success:    true,
        timing:     { tokenMs, totalMs: Date.now() - t0 },
        claims,
        tokenResponseShape: {
          hasAccessToken:  !!tokenResponse.access_token,
          hasIdToken:      !!tokenResponse.id_token,
          hasRefreshToken: !!tokenResponse.refresh_token,
          expiresIn:       tokenResponse.expires_in,
          scope:           tokenResponse.scope,
          tokenType:       tokenResponse.token_type,
        },
        // Hint to the operator: which legacy-login fields appear to be present
        // in the Keycloak ID token, so we know if a GraphQL fallback is needed.
        claimCoverage: {
          sub:               !!claims.sub,
          email:             !!claims.email,
          name:              !!(claims.name || (claims.given_name && claims.family_name)),
          role_or_user_type: !!(claims.role || claims.user_type || claims.preferred_username),
          company_id:        !!(claims.company_id || claims.companyId || claims.organisation_id),
          contact_id:        !!(claims.contact_id || claims.contactId),
          employee_id:       !!(claims.employee_id || claims.employeeId),
          // Carerix-specific guesses; flag everything we can see for the diff
          carerix_user_id:   claims.carerix_user_id ?? claims.cx_user_id ?? null,
        },
      };
    } catch (err) {
      probeResult = {
        success: false,
        timing:  { totalMs: Date.now() - t0 },
        error: {
          status:  err.statusCode || err.status || 500,
          message: err.message,
        },
      };
    }

    await writeAuditLog({
      eventType:   'oidc_login_probe',
      actorUserId: req.user.id,
      actorRole:   req.user.role,
      payload: {
        probedUsername: username,
        success:        probeResult.success,
        totalMs:        probeResult.timing?.totalMs ?? null,
      },
      ipAddress: req.ip,
    }).catch(() => { /* swallow — audit table issues handled elsewhere */ });

    res.json(probeResult);
  } catch (err) { next(err); }
});

export default router;
