/**
 * Carerix Service
 *
 * OAuth2 / OpenID Connect integration with Carerix Identity Server.
 *
 * Auth flow:
 *   1. Frontend redirects user to Carerix login page (authorization_code flow)
 *   2. Carerix redirects back to /auth/carerix/callback with a code
 *   3. Backend exchanges code for tokens at token endpoint
 *   4. Backend fetches user identity from userinfo endpoint
 *   5. Backend provisions Supabase session
 *
 * GraphQL API:
 *   - Backend uses client_credentials flow to get a service token
 *   - Service token is used for data queries (candidates, placements, fees)
 */

import axios from 'axios';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { adminSupabase } from './supabase.js';

// ── Service token cache (client_credentials) ──────────────────────────────────
let _serviceToken     = null;
let _serviceTokenExp  = 0;

/**
 * Gets a service-level access token using client_credentials flow.
 * Used for GraphQL queries (fee retrieval, candidate lookups).
 * Caches the token until 60s before expiry.
 */
async function getServiceToken() {
  const now = Date.now();
  if (_serviceToken && now < _serviceTokenExp) return _serviceToken;

  // Match the working Python app exactly:
  // 1. Try HTTP Basic Auth first (raw base64, NO URL encoding)
  // 2. Fall back to credentials in body if 400/401
  const basicAuth = Buffer.from(
    `${config.carerix.clientId}:${config.carerix.clientSecret}`
  ).toString('base64');

  const baseForm = new URLSearchParams({ grant_type: 'client_credentials' });

  let res;
  try {
    res = await axios.post(config.carerix.tokenUrl, baseForm, {
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth}`,
        'User-Agent':    'confair-platform/1.0',
      },
      timeout: 10_000,
    });
  } catch (basicErr) {
    const status = basicErr.response?.status;
    logger.warn('Basic Auth failed, trying body params', { status, error: basicErr.response?.data });
    if (status === 400 || status === 401 || status === 403) {
      // Fallback: credentials in body
      const bodyForm = new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     config.carerix.clientId,
        client_secret: config.carerix.clientSecret,
      });
      res = await axios.post(config.carerix.tokenUrl, bodyForm, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent':   'confair-platform/1.0',
        },
        timeout: 10_000,
      });
    } else {
      throw new Error(`Carerix token fetch failed: ${basicErr.response?.data?.error_description || basicErr.message}`);
    }
  }

  if (!res?.data?.access_token) {
    throw new Error(`Carerix token response had no access_token: ${JSON.stringify(res?.data)}`);
  }

  _serviceToken    = res.data.access_token;
  _serviceTokenExp = now + (res.data.expires_in - 60) * 1000;
  logger.info('Carerix service token refreshed', { expiresIn: res.data.expires_in });
  return _serviceToken;
}


// ── GraphQL client ─────────────────────────────────────────────────────────────
export async function queryGraphQL(query, variables = {}) {
  return carerixGQL(query, variables);
}

async function carerixGQL(query, variables = {}) {
  const token = await getServiceToken();
  const res = await axios.post(config.carerix.graphApiUrl, { query, variables }, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'User-Agent':    'confair-platform/1.0',
    },
    timeout: 6_000,
  });
  if (res.data.errors?.length) {
    logger.warn('Carerix GraphQL errors', { errors: res.data.errors });
  }
  return res.data;
}

// ── OAuth2 Authorization Code Flow ────────────────────────────────────────────

/**
 * Builds the Carerix login redirect URL.
 * The frontend sends the user here to log in.
 */
export function getCarerixAuthUrl(state, redirectUri) {
  const params = new URLSearchParams({
    client_id:     config.carerix.clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         'openid profile email',
    state,
  });
  return `${config.carerix.authCodeUrl}?${params.toString()}`;
}

/**
 * Exchanges an authorization code for tokens.
 * Called from the OAuth callback route.
 */
export async function exchangeCodeForTokens(code, redirectUri) {
  try {
    const res = await axios.post(config.carerix.tokenUrl,
      new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     config.carerix.clientId,
        client_secret: config.carerix.clientSecret,
        code,
        redirect_uri:  redirectUri,
      }), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent':   'confair-platform/1.0',
        },
        timeout: 10_000,
      }
    );
    return {
      accessToken:  res.data.access_token,
      idToken:      res.data.id_token,
      refreshToken: res.data.refresh_token,
      expiresIn:    res.data.expires_in,
    };
  } catch (err) {
    logger.error('Carerix code exchange failed', {
      error: err.message,
      data:  err.response?.data,
    });
    throw new Error(`Code exchange failed: ${err.response?.data?.error_description || err.message}`);
  }
}

/**
 * Fetches user identity from Carerix userinfo endpoint.
 * Returns normalised identity object.
 */
export async function getCarerixUserInfo(accessToken) {
  try {
    const res = await axios.get(config.carerix.userInfoUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent':    'confair-platform/1.0',
      },
      timeout: 10_000,
    });

    const u = res.data;
    logger.debug('Carerix userinfo', { sub: u.sub, email: u.email });

    // Map Carerix role/claims → platform role
    const platformRole = mapCarerixRole(u);

    return {
      carerixUserId:    u.sub,
      carerixCompanyId: u.company_id || u.companyId || u.organisation_id || null,
      carerixContactId: u.contact_id || u.contactId || null,
      email:            u.email,
      fullName:         u.name || `${u.given_name || ''} ${u.family_name || ''}`.trim(),
      roleInCarerix:    u.role || u.user_type || null,
      platformRole,
      rawPayload:       u,
    };
  } catch (err) {
    logger.error('Carerix userinfo failed', { error: err.message, status: err.response?.status });
    throw new Error(`Userinfo failed: ${err.message}`);
  }
}

function mapCarerixRole(userInfo) {
  // Carerix may return role info in different fields depending on version
  const role = userInfo.role || userInfo.user_type || userInfo.preferred_username || '';
  const roleMap = {
    Candidate:   'placement',
    Employee:    'placement',
    candidate:   'placement',
    Contact:     'company_admin',
    ClientUser:  'company_user',
    ClientAdmin: 'company_admin',
    contact:     'company_admin',
  };
  // Check roles array if present
  if (Array.isArray(userInfo.roles)) {
    if (userInfo.roles.includes('candidate')) return 'placement';
    if (userInfo.roles.includes('contact'))   return 'company_admin';
  }
  return roleMap[role] || 'placement';
}

// ── Identity cache sync ───────────────────────────────────────────────────────
export async function syncIdentityCache(identity) {
  const { error } = await adminSupabase
    .from('carerix_identity_cache')
    .upsert({
      carerix_user_id:    identity.carerixUserId,
      carerix_company_id: identity.carerixCompanyId,
      full_name:          identity.fullName,
      email:              identity.email,
      role_in_carerix:    identity.roleInCarerix,
      raw_payload:        identity.rawPayload,
      fetched_at:         new Date().toISOString(),
      is_stale:           false,
    }, { onConflict: 'carerix_user_id' });
  if (error) logger.error('Identity cache sync failed', { error });
}

// ── Fee retrieval via GraphQL ─────────────────────────────────────────────────

/**
 * Fetches the applicable fee for a placement from Carerix GraphQL.
 * Looks up the match/placement record and returns the agreed rate.
 */
export async function fetchFeeFromCarerix(placementRef, companyRef, declarationTypeCode, periodDate) {
  try {
    // Query the match record for this placement to get the agreed rate
    const data = await carerixGQL(`
      query GetPlacementRate($qualifier: String) {
        crMatchPage(qualifier: $qualifier, pageable: { page: 0, size: 1 }) {
          items {
            _id
            additionalInfo
            toPublication {
              _id
              salary
              salaryMax
            }
          }
        }
      }
    `, {
      qualifier: `toEmployee.employeeID = '${placementRef}'`,
    });

    const match = data?.data?.crMatchPage?.items?.[0];
    if (!match) {
      return { found: false, reason: `No match found in Carerix for placement ${placementRef}` };
    }

    // Extract rate from match — exact field depends on your Carerix configuration
    const rate = match.toPublication?.salary || null;

    return {
      found:      !!rate,
      feeAmount:  rate,
      feeUnit:    'hours',
      currency:   'EUR',
      validFrom:  null,
      validUntil: null,
      rawPayload: match,
    };
  } catch (err) {
    logger.error('Carerix fee fetch failed', { error: err.message, placementRef });
    return { found: false, reason: `GraphQL error: ${err.message}` };
  }
}

export async function fetchAndCacheFee(placementRef, companyRef, declarationTypeCode, referenceDate) {
  const result = await fetchFeeFromCarerix(placementRef, companyRef, declarationTypeCode, referenceDate);

  const { data, error } = await adminSupabase
    .from('carerix_fee_cache')
    .upsert({
      carerix_placement_ref: placementRef,
      carerix_company_ref:   companyRef,
      declaration_type_code: declarationTypeCode,
      fee_amount:            result.found ? result.feeAmount  : null,
      fee_currency:          result.found ? result.currency   : 'EUR',
      fee_unit:              result.found ? result.feeUnit    : null,
      valid_from:            result.found ? result.validFrom  : null,
      valid_until:           result.found ? result.validUntil : null,
      raw_payload:           result.found ? result.rawPayload : null,
      retrieval_status:      result.found ? 'retrieved'       : 'failed',
      retrieval_error:       result.found ? null              : result.reason,
      fetched_at:            new Date().toISOString(),
    }, {
      onConflict:       'carerix_placement_ref,carerix_company_ref,declaration_type_code,valid_from',
      ignoreDuplicates: false,
    })
    .select('id, retrieval_status, fee_amount')
    .single();

  if (error) {
    logger.error('Failed to write fee cache', { error, placementRef });
    return null;
  }
  return data;
}

export async function bulkFetchFees(entries, referenceDate, concurrency = 5) {
  const results = [];
  for (let i = 0; i < entries.length; i += concurrency) {
    const batch = entries.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      batch.map(e => fetchAndCacheFee(e.placementRef, e.companyRef, e.declarationTypeCode, referenceDate))
    );
    results.push(...settled);
  }
  return results;
}

// ── Diagnostic test ───────────────────────────────────────────────────────────
export async function testCarerixConnection() {
  const results = { steps: [], config: {
    authUrl:      config.carerix.authUrl,
    tokenUrl:     config.carerix.tokenUrl,
    graphApiUrl:  config.carerix.graphApiUrl,
    clientId:     config.carerix.clientId,
    tenantId:     config.carerix.tenantId,
    hasSecret:    !!config.carerix.clientSecret,
  }};

  // Step 1: Discovery
  try {
    const r = await axios.get(`${config.carerix.authUrl}/../../../.well-known/openid-configuration`.replace(/\/protocol.*/, '/.well-known/openid-configuration'), { timeout: 8000 });
    results.steps.push({ step: 'discovery', status: 'success', issuer: r.data.issuer });
  } catch (err) {
    results.steps.push({ step: 'discovery', status: 'failed', error: err.message });
  }

  // Step 2: Client credentials token
  try {
    const token = await getServiceToken();
    results.steps.push({ step: 'client_credentials', status: 'success', hasToken: !!token });

    // Step 3: GraphQL query
    try {
      const data = await carerixGQL(`query { crEmployeePage(pageable:{page:0,size:1}) { totalElements } }`);
      results.steps.push({ step: 'graphql_query', status: 'success', data: data?.data });
    } catch (err) {
      results.steps.push({ step: 'graphql_query', status: 'failed', error: err.message });
    }
  } catch (err) {
    results.steps.push({ step: 'client_credentials', status: 'failed',
      error: err.message, tokenUrl: config.carerix.tokenUrl });
  }

  results.overallStatus = results.steps.every(s => s.status === 'success') ? 'connected' : 'partial_or_failed';
  return results;
}
