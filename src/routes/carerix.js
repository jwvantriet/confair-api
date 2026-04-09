/**
 * Carerix routes
 *
 * GET  /carerix/test              — Full connection diagnostic (no auth)
 * POST /carerix/sync/fees/:id     — Re-trigger fee retrieval (Agency)
 * GET  /carerix/fees/status/:id   — Fee retrieval status (Agency)
 */
import { Router } from 'express';
import { requireAuth, requireAgency } from '../middleware/auth.js';
import { adminSupabase } from '../services/supabase.js';
import { fetchAndCacheFee, testCarerixConnection } from '../services/carerix.js';
import { ApiError } from '../middleware/errorHandler.js';

const router = Router();

// ── GET /carerix/test-login — diagnose what Carerix returns for a user (no auth)
router.get('/test-login', async (req, res) => {
  const { u } = req.query;
  if (!u) return res.status(400).json({ error: 'Pass ?u=username to test' });

  const axios    = (await import('axios')).default;
  const config   = (await import('../config.js')).config;
  const crypto   = (await import('crypto')).default;
  const restBase = config.carerix.restUrl;
  const restAuth = Buffer.from(`${config.carerix.restUsername}:${config.carerix.restPassword}`).toString('base64');

  const results = {};

  // Step 1: Try login-with-encrypted-password with a dummy hash to see field structure
  try {
    const r = await axios.get(`${restBase}CRUser/login-with-encrypted-password`, {
      params: { u, p: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', show: 'toEmployee' },
      headers: { 'Authorization': `Basic ${restAuth}`, 'Accept': 'application/json', 'User-Agent': 'confair-platform/1.0' },
      timeout: 10_000,
    });
    results.loginResponse = r.data;
  } catch (e) {
    results.loginError = { status: e.response?.status, data: e.response?.data, message: e.message };
  }

  // Step 2: Look up CRUser by userName
  try {
    const r = await axios.get(`${restBase}CRUser`, {
      params: { qualifier: `userName = '${u}'`, show: '_id,userName,toEmployee._id,toEmployee.employeeID,toContact._id,toContact.toCompany._id,toContact.toCompany.name', limit: 2 },
      headers: { 'Authorization': `Basic ${restAuth}`, 'Accept': 'application/json', 'User-Agent': 'confair-platform/1.0' },
      timeout: 10_000,
    });
    results.crUserLookup = r.data;
  } catch (e) {
    results.crUserError = { status: e.response?.status, data: e.response?.data?.substring?.(0,500), message: e.message };
  }

  // Step 3: Look up CRContact by emailAddress
  try {
    const r = await axios.get(`${restBase}CRContact`, {
      params: { qualifier: `emailAddress = '${u}'`, show: '_id,toCompany._id,toCompany.name', limit: 2 },
      headers: { 'Authorization': `Basic ${restAuth}`, 'Accept': 'application/json', 'User-Agent': 'confair-platform/1.0' },
      timeout: 10_000,
    });
    results.crContactLookup = r.data;
  } catch (e) {
    results.crContactError = { status: e.response?.status, message: e.message };
  }

  res.json(results);
});

// Diagnostic — no auth required
router.get('/test', async (req, res) => {
  const results = await testCarerixConnection();
  res.json(results);
});

router.use(requireAuth, requireAgency);

router.post('/sync/fees/:periodId', async (req, res, next) => {
  try {
    const { data: entries } = await adminSupabase
      .from('declaration_entries')
      .select('id, entry_date, imported_amount, fee_retrieval_status, declaration_types(code), placements(placement_ref), companies(company_ref)')
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
