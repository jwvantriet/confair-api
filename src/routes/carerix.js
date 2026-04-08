/**
 * Carerix routes — Agency only
 *
 * GET  /carerix/test                  — Diagnose Carerix connection (no auth needed for testing)
 * GET  /carerix/discover              — Fetch OpenID discovery document
 * POST /carerix/sync/fees/:periodId   — Re-trigger fee retrieval for a period
 * GET  /carerix/fees/status/:periodId — Fee retrieval status overview
 */

import { Router } from 'express';
import axios from 'axios';
import { requireAuth, requireAgency } from '../middleware/auth.js';
import { adminSupabase } from '../services/supabase.js';
import { fetchAndCacheFee } from '../services/carerix.js';
import { ApiError } from '../middleware/errorHandler.js';
import { config } from '../config.js';

const router = Router();

// ─── GET /carerix/test — NO auth required, for diagnostics ────────────────────
// Tests the full Carerix connection chain and returns detailed results.
// Remove or protect this endpoint once Carerix is confirmed working.
router.get('/test', async (req, res) => {
  const results = {
    config: {
      graphApiUrl:   config.carerix.graphApiUrl,
      financeApiUrl: config.carerix.financeApiUrl,
      tenantId:      config.carerix.tenantId,
      apiKeySet:     config.carerix.apiKey !== 'not-configured' && config.carerix.apiKey !== 'placeholder',
    },
    steps: [],
    overallStatus: 'unknown',
  };

  // ── Step 1: Try to fetch OpenID discovery document ──────────────────────────
  const tenantBase = config.carerix.graphApiUrl
    .replace('/api/graphql', '')
    .replace('/graphql', '')
    .replace('https://api.carerix.io', `https://${config.carerix.tenantId}.apps.carerix.io`);

  const discoveryUrls = [
    `${tenantBase}/.well-known/openid-configuration`,
    `https://${config.carerix.tenantId}.apps.carerix.io/.well-known/openid-configuration`,
    `https://id.carerix.io/auth/realms/${config.carerix.tenantId}/.well-known/openid-configuration`,
  ];

  let discoveryDoc = null;
  for (const url of discoveryUrls) {
    try {
      const r = await axios.get(url, { timeout: 8000 });
      discoveryDoc = r.data;
      results.steps.push({ step: 'openid_discovery', status: 'success', url, endpoints: {
        authorization: r.data.authorization_endpoint,
        token:         r.data.token_endpoint,
        userinfo:      r.data.userinfo_endpoint,
      }});
      break;
    } catch (err) {
      results.steps.push({ step: 'openid_discovery', status: 'failed', url, error: err.message });
    }
  }

  // ── Step 2: Try client_credentials token with confidential client ───────────
  if (discoveryDoc?.token_endpoint) {
    try {
      const tokenRes = await axios.post(discoveryDoc.token_endpoint,
        new URLSearchParams({
          grant_type:    'client_credentials',
          client_id:     config.carerix.tenantId,    // Client ID from Carerix
          client_secret: config.carerix.apiKey,       // Client Secret from Carerix
          scope:         'openid',
        }), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 8000,
        }
      );
      results.steps.push({ step: 'client_credentials_token', status: 'success',
        tokenType: tokenRes.data.token_type,
        expiresIn: tokenRes.data.expires_in,
        hasAccessToken: !!tokenRes.data.access_token,
      });

      // ── Step 3: Try a simple GraphQL query with the token ──────────────────
      if (tokenRes.data.access_token) {
        try {
          const gqlRes = await axios.post('https://api.carerix.io/graphql/v1/graphql', {
            query: `query { crEmployeePage(pageable: { page: 0, size: 1 }) { totalElements } }`,
          }, {
            headers: {
              'Authorization': `Bearer ${tokenRes.data.access_token}`,
              'Content-Type':  'application/json',
              'User-Agent':    'confair-platform/1.0',
            },
            timeout: 10000,
          });
          results.steps.push({ step: 'graphql_query', status: 'success',
            data: gqlRes.data?.data,
            errors: gqlRes.data?.errors || null,
          });
        } catch (err) {
          results.steps.push({ step: 'graphql_query', status: 'failed', error: err.message,
            response: err.response?.data });
        }
      }
    } catch (err) {
      results.steps.push({ step: 'client_credentials_token', status: 'failed',
        error: err.message,
        response: err.response?.data,
        tokenEndpointUsed: discoveryDoc?.token_endpoint,
      });
    }
  } else {
    // Try direct token endpoint guesses if discovery failed
    const tokenGuesses = [
      `https://${config.carerix.tenantId}.apps.carerix.io/auth/realms/carerix/protocol/openid-connect/token`,
      `https://id.carerix.io/auth/realms/${config.carerix.tenantId}/protocol/openid-connect/token`,
    ];
    for (const tokenUrl of tokenGuesses) {
      try {
        const tokenRes = await axios.post(tokenUrl,
          new URLSearchParams({
            grant_type:    'client_credentials',
            client_id:     config.carerix.tenantId,
            client_secret: config.carerix.apiKey,
          }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 8000,
          }
        );
        results.steps.push({ step: 'token_direct_guess', status: 'success', url: tokenUrl,
          hasToken: !!tokenRes.data.access_token });
        break;
      } catch (err) {
        results.steps.push({ step: 'token_direct_guess', status: 'failed', url: tokenUrl,
          error: err.message, httpStatus: err.response?.status, response: err.response?.data });
      }
    }
  }

  // ── Overall status ──────────────────────────────────────────────────────────
  const successes = results.steps.filter(s => s.status === 'success').length;
  results.overallStatus = successes === 0 ? 'no_connection'
    : successes < results.steps.length ? 'partial'
    : 'fully_connected';

  res.json(results);
});

// ─── GET /carerix/discover — fetch raw OpenID config ──────────────────────────
router.get('/discover', async (req, res) => {
  const urls = [
    `https://${config.carerix.tenantId}.apps.carerix.io/.well-known/openid-configuration`,
    `https://id.carerix.io/auth/realms/${config.carerix.tenantId}/.well-known/openid-configuration`,
  ];
  for (const url of urls) {
    try {
      const r = await axios.get(url, { timeout: 8000 });
      return res.json({ url, data: r.data });
    } catch (err) {
      // try next
    }
  }
  res.status(502).json({ error: 'Could not fetch OpenID discovery from any known URL', tried: urls });
});

// ─── Protected routes below ───────────────────────────────────────────────────
router.use(requireAuth, requireAgency);

// POST /carerix/sync/fees/:periodId
router.post('/sync/fees/:periodId', async (req, res, next) => {
  try {
    const { data: entries } = await adminSupabase
      .from('declaration_entries')
      .select('id, entry_date, fee_retrieval_status, declaration_types(code), placements(placement_ref), companies(company_ref)')
      .eq('payroll_period_id', req.params.periodId)
      .eq('fee_retrieval_status', 'pending');

    if (!entries?.length) return res.json({ message: 'No pending fee retrievals', count: 0 });

    let retrieved = 0, failed = 0;
    for (const entry of entries) {
      const result = await fetchAndCacheFee(
        entry.placements.placement_ref,
        entry.companies.company_ref,
        entry.declaration_types.code,
        entry.entry_date
      );
      if (result?.retrieval_status === 'retrieved') {
        await adminSupabase.from('declaration_entries').update({
          fee_cache_id:         result.id,
          fee_amount:           result.fee_amount,
          fee_retrieval_status: 'retrieved',
          calculated_value:     entry.imported_amount * result.fee_amount,
          status:               'fee_retrieved',
        }).eq('id', entry.id);
        retrieved++;
      } else {
        await adminSupabase.from('declaration_entries').update({
          fee_retrieval_status: 'failed',
          status:               'fee_retrieval_failed',
        }).eq('id', entry.id);
        failed++;
      }
    }
    res.json({ message: 'Fee sync complete', retrieved, failed, total: entries.length });
  } catch (err) { next(err); }
});

// GET /carerix/fees/status/:periodId
router.get('/fees/status/:periodId', async (req, res, next) => {
  try {
    const { data, error } = await adminSupabase
      .from('declaration_entries')
      .select('fee_retrieval_status')
      .eq('payroll_period_id', req.params.periodId);
    if (error) throw new ApiError(error.message);
    const summary = data.reduce((acc, row) => {
      acc[row.fee_retrieval_status] = (acc[row.fee_retrieval_status] || 0) + 1;
      return acc;
    }, {});
    res.json(summary);
  } catch (err) { next(err); }
});

export default router;
