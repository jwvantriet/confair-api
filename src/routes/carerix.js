/**
 * Carerix diagnostic routes — no auth required
 */
import { Router } from 'express';
import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import { config } from '../config.js';
import { adminSupabase } from '../services/supabase.js';
import { fetchAndCacheFee, testCarerixConnection } from '../services/carerix.js';
import { requireAuth, requireAgency } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';

const router = Router();
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
const parseXml = (xml) => { try { return xmlParser.parse(xml); } catch { return null; } };

// ── GET /carerix/test — connection test ───────────────────────────────────────
router.get('/test', async (req, res) => {
  const results = await testCarerixConnection();
  res.json(results);
});

// ── GET /carerix/inspect-login — inspect raw login XML for a username ─────────
// Usage: /carerix/inspect-login?u=testaccount@testing.dev&p=MD5_HASH_OF_PASSWORD
// This shows exactly what Carerix returns so we can find the role field
router.get('/inspect-login', async (req, res) => {
  const { u, p } = req.query;
  if (!u || !p) return res.status(400).json({ error: 'Pass ?u=username&p=md5password' });

  const restBase = config.carerix.restUrl;
  const restAuth = Buffer.from(`${config.carerix.restUsername}:${config.carerix.restPassword}`).toString('base64');
  const headers  = { Authorization: `Basic ${restAuth}`, 'User-Agent': 'confair-platform/1.0' };

  const results = {};

  // Try login with various show params
  const showVariants = [
    '',
    'userRoleID',
    'userRoleID,toEmployee,toContact,toCompany,firstName,lastName',
    'groups',
    'toEmployee,toContact,toCompany,toUserRole',
  ];

  for (const show of showVariants) {
    const params = { u, p };
    if (show) params.show = show;
    try {
      const r = await axios.get(`${restBase}CRUser/login-with-encrypted-password`,
        { params, headers, timeout: 10_000, responseType: 'text' });
      const parsed = parseXml(r.data);
      results[`show=${show || '(none)'}`] = {
        raw:    r.data?.substring(0, 1000),
        parsed: parsed,
      };
    } catch (e) {
      results[`show=${show || '(none)'}`] = { error: e.message, status: e.response?.status, raw: e.response?.data?.substring(0, 300) };
    }
  }

  // Also fetch CRUser by ID without show= to see ALL fields
  const crUserId = parseXml(
    (await axios.get(`${restBase}CRUser/login-with-encrypted-password`,
      { params: { u, p }, headers, timeout: 10_000, responseType: 'text' }).catch(() => ({ data: '' }))).data
  )?.CRUser?.['@_id'];

  if (crUserId) {
    // Try various show params on direct CRUser fetch
    for (const show of ['', 'groups', 'toEmployee,toContact,toCompany,toUserRole,userRoleID']) {
      const params = {};
      if (show) params.show = show;
      try {
        const r = await axios.get(`${restBase}CRUser/${crUserId}`,
          { params, headers, timeout: 8_000, responseType: 'text' });
        results[`CRUser/${crUserId} show=${show || '(none)'}`] = {
          raw: r.data?.substring(0, 1000),
          parsed: parseXml(r.data),
        };
      } catch (e) {
        results[`CRUser/${crUserId} show=${show || '(none)'}`] = { error: e.message };
      }
    }

    // Try CREmployee with qualifier show=groups
    try {
      const r = await axios.get(`${restBase}CREmployee`,
        { params: { qualifier: `toUser._id = ${crUserId}`, show: 'groups', limit: 1 }, headers, timeout: 8_000, responseType: 'text' });
      results[`CREmployee qualifier toUser._id show=groups`] = { raw: r.data?.substring(0, 500) };
    } catch (e) {
      results[`CREmployee qualifier toUser._id`] = { error: e.message, status: e.response?.status };
    }
  }

  res.json({ crUserId, results });
});

// ── Protected routes ──────────────────────────────────────────────────────────
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
        entry.placements.placement_ref, entry.companies.company_ref,
        entry.declaration_types.code, entry.entry_date
      );
      if (result?.retrieval_status === 'retrieved') {
        await adminSupabase.from('declaration_entries').update({
          fee_cache_id: result.id, fee_amount: result.fee_amount,
          fee_retrieval_status: 'retrieved',
          calculated_value: entry.imported_amount * result.fee_amount,
          status: 'fee_retrieved',
        }).eq('id', entry.id);
        retrieved++;
      } else {
        await adminSupabase.from('declaration_entries').update({
          fee_retrieval_status: 'failed', status: 'fee_retrieval_failed',
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
      .from('declaration_entries').select('fee_retrieval_status')
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
