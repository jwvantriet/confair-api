/**
 * Carerix Service
 *
 * Two integrations:
 *  1. Carerix Graph API  — authenticates Placement + Company users
 *  2. Carerix Finance API — retrieves fee/rate data per placement × declaration type
 */

import axios from 'axios';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { adminSupabase } from './supabase.js';

const graphClient = axios.create({
  baseURL: config.carerix.graphApiUrl,
  timeout: 10_000,
  headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': config.carerix.tenantId },
});

const financeClient = axios.create({
  baseURL: config.carerix.financeApiUrl,
  timeout: 10_000,
  headers: { 'Content-Type': 'application/json', 'X-API-Key': config.carerix.apiKey, 'X-Tenant-ID': config.carerix.tenantId },
});

// ── Graph API: authenticate a user ───────────────────────────────────────────
export async function authenticateWithCarerix(email, password) {
  const query = `
    mutation Login($email: String!, $password: String!) {
      login(email: $email, password: $password) {
        token
        user {
          id email fullName phone role
          companyId companyName contactId candidateId
        }
      }
    }`;

  let response;
  try {
    response = await graphClient.post('', { query, variables: { email, password } });
  } catch (err) {
    logger.error('Carerix Graph API network error', { err: err.message });
    throw new Error('Unable to reach Carerix authentication service');
  }

  const { data, errors } = response.data;
  if (errors?.length) throw new Error('Invalid Carerix credentials');
  if (!data?.login?.token) throw new Error('Carerix returned no token');

  const { token, user } = data.login;
  return {
    carerixToken:    token,
    carerixUserId:   user.id,
    carerixCompanyId: user.companyId ?? null,
    carerixContactId: user.contactId ?? user.candidateId ?? null,
    email:           user.email,
    fullName:        user.fullName,
    phone:           user.phone ?? null,
    roleInCarerix:   user.role,
    platformRole:    mapCarerixRole(user.role),
    rawPayload:      user,
  };
}

function mapCarerixRole(carerixRole) {
  const map = { Candidate: 'placement', Employee: 'placement', Contact: 'company_admin', ClientUser: 'company_user', ClientAdmin: 'company_admin' };
  return map[carerixRole] ?? 'placement';
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
      phone:              identity.phone,
      role_in_carerix:    identity.roleInCarerix,
      raw_payload:        identity.rawPayload,
      fetched_at:         new Date().toISOString(),
      is_stale:           false,
    }, { onConflict: 'carerix_user_id' });
  if (error) logger.error('Identity cache sync failed', { error });
}

// ── Finance API: fetch a single fee ──────────────────────────────────────────
export async function fetchFeeFromCarerix(placementRef, companyRef, declarationTypeCode, periodDate) {
  try {
    const response = await financeClient.get('/rates', {
      params: { placement_ref: placementRef, company_ref: companyRef, declaration_type: declarationTypeCode, reference_date: periodDate },
    });
    const rate = response.data;
    return { found: true, feeAmount: rate.amount ?? rate.rate ?? null, feeUnit: rate.unit ?? 'hours', currency: rate.currency ?? 'EUR', validFrom: rate.valid_from ?? null, validUntil: rate.valid_until ?? null, rawPayload: rate };
  } catch (err) {
    if (err.response?.status === 404) return { found: false, reason: 'No rate found in Carerix Finance' };
    logger.error('Carerix Finance API error', { err: err.message });
    return { found: false, reason: err.message };
  }
}

// ── Fetch + persist fee to cache ─────────────────────────────────────────────
export async function fetchAndCacheFee(placementRef, companyRef, declarationTypeCode, referenceDate) {
  const result = await fetchFeeFromCarerix(placementRef, companyRef, declarationTypeCode, referenceDate);
  const cacheRow = {
    carerix_placement_ref: placementRef,
    carerix_company_ref:   companyRef,
    declaration_type_code: declarationTypeCode,
    fee_amount:            result.found ? result.feeAmount : null,
    fee_currency:          result.found ? result.currency : 'EUR',
    fee_unit:              result.found ? result.feeUnit : null,
    valid_from:            result.found ? result.validFrom : null,
    valid_until:           result.found ? result.validUntil : null,
    raw_payload:           result.found ? result.rawPayload : null,
    retrieval_status:      result.found ? 'retrieved' : 'failed',
    retrieval_error:       result.found ? null : result.reason,
    fetched_at:            new Date().toISOString(),
  };
  const { data, error } = await adminSupabase
    .from('carerix_fee_cache')
    .upsert(cacheRow, { onConflict: 'carerix_placement_ref,carerix_company_ref,declaration_type_code,valid_from', ignoreDuplicates: false })
    .select('id, retrieval_status, fee_amount')
    .single();
  if (error) { logger.error('Fee cache write failed', { error }); return null; }
  return data;
}

// ── Bulk fee retrieval with concurrency limit ─────────────────────────────────
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
