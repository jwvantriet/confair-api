/**
 * Carerix OAuth2 login (ROPC — Resource Owner Password Credentials grant).
 *
 * Replaces the legacy REST endpoint
 *   GET api.carerix.com/CRUser/login-with-encrypted-password?u=…&p=md5(…)
 * with a single Keycloak token POST. The ID token (a JWT) carries the
 * user's identity claims, so no follow-up userinfo call is needed.
 *
 * The OAuth2 client used here MUST have "Direct Access Grants Enabled"
 * in Carerix Keycloak. If it doesn't, the request returns
 *   400 { error: "unauthorized_client" }
 * which we surface as a 502 so it's clearly distinguished from a bad
 * password (401).
 *
 * Signature verification of the ID token is deferred to a later iteration
 * (would require fetching the realm's JWKS and validating). For now we
 * decode-only and trust the channel + the fact that we issued the request.
 */

import axios from 'axios';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { ApiError } from '../middleware/errorHandler.js';

/**
 * @returns {Promise<{
 *   claims:        Record<string, unknown>,   // decoded ID-token payload
 *   tokenResponse: Record<string, unknown>,   // raw Keycloak response
 * }>}
 */
export async function loginWithCarerixOAuth(username, password) {
  if (!config.carerix.clientId || !config.carerix.clientSecret) {
    throw new ApiError('Carerix OAuth client is not configured (CARERIX_CLIENT_ID / CARERIX_API_KEY missing)', 500);
  }

  const params = new URLSearchParams({
    grant_type:    'password',
    username,
    password,
    client_id:     config.carerix.clientId,
    client_secret: config.carerix.clientSecret,
    scope:         'openid profile email',
  });

  let tokenResp;
  try {
    const res = await axios.post(config.carerix.tokenUrl, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':   'confair-platform/1.0',
      },
      timeout: 10_000,
    });
    tokenResp = res.data;
  } catch (err) {
    const status = err.response?.status;
    const body   = err.response?.data;
    const code   = body?.error;

    if (status === 401 || code === 'invalid_grant') {
      throw new ApiError('Invalid username or password', 401);
    }
    if (code === 'unauthorized_client' || code === 'invalid_client') {
      logger.error('Carerix ROPC: client not allowed to use password grant', {
        clientId: config.carerix.clientId, code, error_description: body?.error_description,
      });
      throw new ApiError(
        'OAuth password grant is not enabled for the configured client. Ask Carerix to enable Direct Access Grants.',
        502,
      );
    }
    logger.error('Carerix ROPC token request failed', { status, body, error: err.message });
    throw new ApiError('Could not reach Carerix identity provider', 502);
  }

  const idToken = tokenResp?.id_token;
  if (!idToken) {
    logger.error('Carerix ROPC: no id_token in token response', { keys: Object.keys(tokenResp || {}) });
    throw new ApiError('Identity provider returned no id_token', 502);
  }

  const claims = jwt.decode(idToken);
  if (!claims || typeof claims !== 'object') {
    throw new ApiError('Could not decode id_token', 502);
  }

  return { claims, tokenResponse: tokenResp };
}
