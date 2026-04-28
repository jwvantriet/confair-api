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

async function getServiceToken() {
  const now = Date.now();
  if (_serviceToken && now < _serviceTokenExp) return _serviceToken;

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


export async function queryGraphQL(query, variables = {}, options = {}) {
  return carerixGQL(query, variables, options);
}

let _checkboxRegistry     = null;
let _checkboxRegistryExp  = 0;

export async function getCarerixCheckboxRegistry({ ttlMs = 15 * 60 * 1000 } = {}) {
  const now = Date.now();
  if (_checkboxRegistry && now < _checkboxRegistryExp) return _checkboxRegistry;

  try {
    const result = await carerixGQL(`
      query CheckboxRegistry($qualifier: String, $pageable: Pageable) {
        crDataNodePage(qualifier: $qualifier, pageable: $pageable) {
          totalElements
          items { _id dataNodeID tag exportCode }
        }
      }
    `, {
      qualifier: 'type.identifier == "Attribute contact"',
      pageable:  { page: 0, size: 500 },
    });

    const items = result?.data?.crDataNodePage?.items || [];
    const registry = {};
    for (const node of items) {
      if (node?.tag !== 'checkboxType') continue;
      if (node?.exportCode == null) continue;
      if (node?.dataNodeID == null) continue;
      registry[String(node.dataNodeID)] = String(node.exportCode);
    }

    _checkboxRegistry    = registry;
    _checkboxRegistryExp = now + ttlMs;
    logger.info('Carerix checkbox registry loaded', { entries: Object.keys(registry).length });
    return registry;
  } catch (err) {
    logger.warn('Carerix checkbox registry fetch failed — returning null so callers fail-closed', { error: err.message });
    return null;
  }
}

export async function fetchPlacementIdentityByCrUserId(crUserId) {
  if (!crUserId) return null;
  const crUserIdNum = Number(crUserId);
  if (!Number.isFinite(crUserIdNum)) return null;
  try {
    const resp = await carerixGQL(`
      query CRUserEmployee($qualifier: String) {
        crUserPage(qualifier: $qualifier, pageable: { page: 0, size: 1 }) {
          items {
            _id
            userID
            toEmployee {
              _id
              employeeID
              toFunction1Level1Node { dataNodeID exportCode value }
            }
          }
        }
      }
    `, { qualifier: `userID == ${crUserIdNum}` });
    const item = resp?.data?.crUserPage?.items?.[0];
    const emp = item?.toEmployee;
    if (!emp) {
      logger.warn('fetchPlacementIdentityByCrUserId: no linked employee', { crUserId: crUserIdNum });
      return null;
    }
    const fg = emp.toFunction1Level1Node || null;
    return {
      employeeID:   emp.employeeID != null ? String(emp.employeeID) : String(emp._id),
      fgLevel1Id:   fg?.dataNodeID != null ? String(fg.dataNodeID) : null,
      fgLevel1Code: fg?.exportCode != null ? String(fg.exportCode) : null,
      fgLevel1Name: fg?.value || null,
    };
  } catch (err) {
    logger.warn('fetchPlacementIdentityByCrUserId failed', { crUserId, error: err.message });
    return null;
  }
}

async function carerixGQL(query, variables = {}, { timeoutMs = 30_000 } = {}) {
  const token = await getServiceToken();
  const res = await axios.post(config.carerix.graphApiUrl, { query, variables }, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'User-Agent':    'confair-platform/1.0',
    },
    timeout: timeoutMs,
  });
  if (res.data.errors?.length) {
    logger.warn('Carerix GraphQL errors', { errors: res.data.errors });
  }
  return res.data;
}

// ── OAuth2 Authorization Code Flow ────────────────────────────────────────────

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
  if (Array.isArray(userInfo.roles)) {
    if (userInfo.roles.includes('candidate')) return 'placement';
    if (userInfo.roles.includes('contact'))   return 'company_admin';
  }
  return roleMap[role] || 'placement';
}

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

export async function fetchFeeFromCarerix(placementRef, companyRef, declarationTypeCode, periodDate) {
  try {
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

export async function testCarerixConnection() {
  const results = { steps: [], config: {
    authUrl:      config.carerix.authUrl,
    tokenUrl:     config.carerix.tokenUrl,
    graphApiUrl:  config.carerix.graphApiUrl,
    clientId:     config.carerix.clientId,
    tenantId:     config.carerix.tenantId,
    hasSecret:    !!config.carerix.clientSecret,
  }};

  try {
    const r = await axios.get(`${config.carerix.authUrl}/../../../.well-known/openid-configuration`.replace(/\/protocol.*/, '/.well-known/openid-configuration'), { timeout: 8000 });
    results.steps.push({ step: 'discovery', status: 'success', issuer: r.data.issuer });
  } catch (err) {
    results.steps.push({ step: 'discovery', status: 'failed', error: err.message });
  }

  try {
    const token = await getServiceToken();
    results.steps.push({ step: 'client_credentials', status: 'success', hasToken: !!token });

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

export function normalizeCurrency(raw) {
  if (!raw) return 'USD';
  const u = raw.toUpperCase().trim();
  if (u === 'EUR' || u.includes('EURO')) return 'EUR';
  if (u === 'USD' || u.includes('DOLLAR') || u.includes('US ')) return 'USD';
  if (u === 'GBP' || u.includes('POUND') || u.includes('STERLING')) return 'GBP';
  if (/^[A-Z]{3}$/.test(u)) return u;
  return 'USD';
}

export async function fetchCarerixRatesForJob(carerixJobId) {
  try {
    const result = await queryGraphQL(`
      query JobFinancePage($qualifier: String, $pageable: Pageable) {
        crJobFinancePage(qualifier: $qualifier, pageable: $pageable) {
          items {
            _id
            toFinance {
              _id
              amount
              startDate
              endDate
              toKindNode { dataNodeID value }
              toCurrencyNode { dataNodeID value }
              toTypeNode { typeID }
            }
          }
        }
      }
    `, {
      qualifier: 'toJob.jobID == ' + parseInt(carerixJobId),
      pageable: { page: 0, size: 100 }
    });

    const items = result?.data?.crJobFinancePage?.items || [];
    const rateMap = {};
    const today = new Date().toISOString().split('T')[0];

    for (const item of items) {
      const finance = item?.toFinance;
      if (!finance) continue;
      const endDate = finance.endDate ? String(finance.endDate).split('T')[0] : null;
      if (endDate && endDate < today) continue;
      const kindId = finance.toKindNode?.dataNodeID;
      if (!kindId) continue;
      const amount = finance.amount != null ? Number(finance.amount) : null;
      const currency = normalizeCurrency((finance.toCurrencyNode?.value || '').trim());
      if (!rateMap[kindId] && amount != null) {
        rateMap[kindId] = { amount, currency };
      }
    }

    return rateMap;
  } catch (err) {
    console.warn('fetchCarerixRatesForJob failed', { carerixJobId, error: err.message });
    return {};
  }
}

// ── Crew code → Carerix job matching ─────────────────────────────────────────

// Crew codes in Carerix are 3 OR 4 uppercase letters (e.g. BNY = Benony,
// BENO = Benoit). Anything else is treated as "no code".
const CREW_CODE_REGEX = /^[A-Z]{3,4}$/;

/**
 * Query Carerix jobs and build a map of { "BNY" -> "jobId", ... }
 * Crew code is stored in additionalInfo field 10189 on the crJob record.
 */
export async function buildCrewCodeToJobMap({ targetCodes = null, maxPages = 100 } = {}) {
  const CREW_CODE_FIELD = '10189';
  const codeToJob = {};
  const size = 100;
  let totalFetched = 0;
  let pagesScanned = 0;
  const needed = targetCodes ? new Set([...targetCodes].map(c => c.toUpperCase())) : null;

  for (let page = 0; page < maxPages; page++) {
    let items, total;
    try {
      const result = await queryGraphQL(`
        query ActiveJobs($pageable: Pageable) {
          crJobPage(pageable: $pageable) {
            totalElements
            items { _id jobID additionalInfo }
          }
        }
      `, { pageable: { page, size, sort: [{ property: 'modificationDate', direction: 'DESC' }] } });
      items = result?.data?.crJobPage?.items || [];
      total = result?.data?.crJobPage?.totalElements || 0;
    } catch (err) {
      logger.warn('crJobPage fetch failed (continuing)', { page, error: err.message });
      break;
    }

    for (const job of items) {
      const ai = job?.additionalInfo;
      if (!ai || typeof ai !== 'object') continue;
      const raw = ai[CREW_CODE_FIELD] ?? ai[`_${CREW_CODE_FIELD}`] ?? null;
      if (!raw) continue;
      const code = String(raw).trim().toUpperCase();
      if (CREW_CODE_REGEX.test(code) && !codeToJob[code]) {
        codeToJob[code] = String(job.jobID || job._id);
      }
    }

    totalFetched += items.length;
    pagesScanned++;

    if (needed && needed.size > 0) {
      const stillMissing = [...needed].some(c => !codeToJob[c]);
      if (!stillMissing) break;
    }

    if (totalFetched >= total || items.length < size) break;
  }

  logger.info('Carerix crew code map built', {
    pagesScanned,
    jobsScanned: totalFetched,
    codesFound:  Object.keys(codeToJob).length,
    targetCount: needed?.size ?? null,
    targetsResolved: needed ? [...needed].filter(c => codeToJob[c]).length : null,
  });
  return codeToJob;
}

export async function autoMatchPlacementsCarerixIds() {
  const { data: unmatched } = await adminSupabase
    .from('placements')
    .select('id, crew_id, full_name')
    .is('carerix_job_id', null)
    .not('crew_id', 'is', null);

  if (!unmatched?.length) return { matched: 0, unmatched: 0, details: [] };

  const targetCodes = unmatched
    .map(p => p.crew_id?.toUpperCase())
    .filter(Boolean);
  const codeToJob = await buildCrewCodeToJobMap({ targetCodes });
  const details   = [];
  let matched     = 0;

  for (const placement of unmatched) {
    const code  = placement.crew_id?.toUpperCase();
    const jobId = codeToJob[code];
    if (jobId) {
      const { error } = await adminSupabase
        .from('placements')
        .update({ carerix_job_id: jobId, carerix_placement_id: jobId })
        .eq('id', placement.id);
      if (!error) {
        matched++;
        details.push({ crew_id: code, carerix_job_id: jobId, status: 'matched' });
        logger.info('Auto-matched placement to Carerix job', { crew_id: code, jobId });
      } else {
        details.push({ crew_id: code, carerix_job_id: jobId, status: 'db_error', error: error.message });
      }
    } else {
      details.push({ crew_id: code, carerix_job_id: null, status: 'not_found_in_carerix' });
    }
  }

  return { matched, unmatched: unmatched.length - matched, details };
}
