/**
 * Carerix diagnostic routes — no auth required
 */
import { Router } from 'express';
import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import { config } from '../config.js';
import { adminSupabase } from '../services/supabase.js';
import { fetchAndCacheFee, testCarerixConnection } from '../services/carerix.js';
import { syncCarerixCompany } from '../services/carerix_company_sync.js';
import { requireAuth, requireAgency } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = Router();
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
const parseXml = (xml) => { try { return xmlParser.parse(xml); } catch { return null; } };

// ── GET /carerix/explorer — GraphQL explorer UI (no auth) ───────────────────
// Explorer uses inline onclick handlers + inline <script>, so the default
// helmet CSP blocks every interaction. Relax the CSP for this single debug
// page (allow 'unsafe-inline' + 'unsafe-eval') so clicks / scripts work.
router.get('/explorer', (req, res) => {
  try {
    const html = readFileSync(join(__dirname, 'carerix_explorer.html'), 'utf8');
    res.setHeader('Content-Type', 'text/html');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self' 'unsafe-inline' 'unsafe-eval'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "connect-src *",
        "img-src * data:",
        "font-src * data:",
      ].join('; '),
    );
    res.send(html);
  } catch(e) {
    res.status(500).send('Explorer file not found: ' + e.message);
  }
});

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


// ── GET /carerix/invoice-data/:jobId — all data needed for invoice generation ─
// Uses _id param (correct Carerix convention), fetches job + employee + company
router.get('/invoice-data/:jobId', async (req, res, next) => {
  try {
    const { queryGraphQL } = await import('../services/carerix.js');

    // Step 1: fetch job to get employee ID and company
    const jobResult = await queryGraphQL(`
      query JobDetail($id: ID!) {
        crJob(_id: $id) {
          _id jobID name
          additionalInfo
          additionalInfoList
          toCompany { _id companyID name }
          toEmployee { _id employeeID }
        }
      }
    `, { id: String(req.params.jobId) });

    const job = jobResult?.data?.crJob;
    if (!job) return res.json({ error: 'Job not found', raw: jobResult });

    // Step 2: fetch employee detail with address + banking
    const empId = job.toEmployee?._id;
    let employee = null;
    if (empId) {
      const empResult = await queryGraphQL(`
        query EmpDetail($id: ID!) {
          crEmployee(_id: $id) {
            _id employeeID firstName lastName name
            paymentIbanCode paymentBicCode paymentAccountName
            homeFullAddress homeStreet homeNumber homeNumberSuffix
            homePostalCode homeCity
            toHomeCountryNode { value }
          }
        }
      `, { id: String(empId) });
      employee = empResult?.data?.crEmployee;
    }

    // Step 3: fetch company details
    const compId = job.toCompany?._id;
    let company = null;
    if (compId) {
      const compResult = await queryGraphQL(`
        query CompDetail($id: ID!) {
          crCompany(_id: $id) {
            _id companyID name
            visitCity visitPostalCode visitStreet visitNumber
            toVisitCountryNode { value }
            emailAddress phone vatNumber
          }
        }
      `, { id: String(compId) });
      company = compResult?.data?.crCompany;
    }

    // Parse additionalInfo for legal name (10278) and VAT (10978)
    const ai = {};
    const rawAI = job.additionalInfo || job.additionalInfoList || {};
    if (typeof rawAI === 'object') {
      for (const [k, v] of Object.entries(rawAI)) {
        ai[k.replace(/^_/, '')] = v;
      }
    }

    res.json({ job, employee, company, additionalInfo: ai });
  } catch (err) { next(err); }
});


// ── GET /carerix/employee-finances/:employeeId — fetch finances via service token ──
// Uses Carerix service credentials directly, no user auth needed
router.get('/employee-finances/:employeeId', async (req, res, next) => {
  try {
    const { queryGraphQL } = await import('../services/carerix.js');
    const { employeeId } = req.params;
    const result = await queryGraphQL(`
      query EmployeeFinancePage($qualifier: String, $pageable: Pageable) {
        crEmployeeFinancePage(qualifier: $qualifier, pageable: $pageable) {
          items {
            _id
            toFinance {
              _id
              startDate
              endDate
              amount
              cost
              info
              toKindNode { dataNodeID value }
              toCurrencyNode { dataNodeID value }
              toTypeNode { typeID identifier }
            }
          }
        }
      }
    `, {
      qualifier: 'toEmployee.employeeID == ' + empId,
      pageable: { page: 0, size: 100 }
    });
    res.json(result);
  } catch (err) { next(err); }
});

// ── GET /carerix/job-finances/:jobId — fetch job-level finances ────────────────
router.get('/job-finances/:jobId', async (req, res, next) => {
  try {
    const { queryGraphQL } = await import('../services/carerix.js');
    const { jobId } = req.params;
    const result = await queryGraphQL(`
      query JobFinancePage($qualifier: String, $pageable: Pageable) {
        crJobFinancePage(qualifier: $qualifier, pageable: $pageable) {
          items {
            _id
            toJob { _id jobID name }
            toFinance {
              _id
              startDate
              endDate
              amount
              cost
              info
              toKindNode { dataNodeID value }
              toCurrencyNode { dataNodeID value }
              toTypeNode { typeID identifier }
            }
          }
        }
      }
    `, {
      qualifier: 'toJob.jobID == ' + jobId,
      pageable: { page: 0, size: 100 }
    });
    res.json(result);
  } catch (err) { next(err); }
});


// ── GET /carerix/probe — debug Carerix field availability (service token) ─────
router.get('/probe', async (req, res, next) => {
  try {
    const { queryGraphQL } = await import('../services/carerix.js');
    const results = {};

    // Test 1: basic introspection
    try {
      const r = await queryGraphQL('{ __typename }', {});
      results.introspection = r?.data || r?.errors?.[0]?.message || 'no data';
    } catch(e) { results.introspection = 'ERROR: ' + e.message; }

    // Test 2: crJob with _id
    try {
      const r = await queryGraphQL('query { crJob(_id: "5319") { _id jobID name } }', {});
      results.crJob_id = r?.data?.crJob || r?.errors?.[0]?.message || 'null';
    } catch(e) { results.crJob_id = 'ERROR: ' + e.message; }

    // Test 3: crJob with variable
    try {
      const r = await queryGraphQL('query J($id: ID!) { crJob(_id: $id) { _id jobID name } }', { id: '5319' });
      results.crJob_var = r?.data?.crJob || r?.errors?.[0]?.message || 'null';
    } catch(e) { results.crJob_var = 'ERROR: ' + e.message; }

    // Test 4: additionalInfo on job
    try {
      const r = await queryGraphQL('query { crJob(_id: "5319") { additionalInfo additionalInfoList } }', {});
      results.additionalInfo = r?.data?.crJob || r?.errors?.[0]?.message || 'null';
    } catch(e) { results.additionalInfo = 'ERROR: ' + e.message; }

    // Test 5: employee directly
    try {
      const r = await queryGraphQL('query { crEmployee(_id: "14") { _id employeeID firstName lastName homeCity homePostalCode paymentIbanCode paymentBicCode paymentAccountName } }', {});
      results.employee14 = r?.data?.crEmployee || r?.errors?.[0]?.message || 'null';
    } catch(e) { results.employee14 = 'ERROR: ' + e.message; }

    // Test 6: company
    try {
      const r = await queryGraphQL('query { crJob(_id: "5319") { toCompany { _id name companyID } toEmployee { _id employeeID } } }', {});
      results.jobRelations = r?.data?.crJob || r?.errors?.[0]?.message || 'null';
    } catch(e) { results.jobRelations = 'ERROR: ' + e.message; }

    res.json(results);
  } catch (err) { next(err); }
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



// ── POST /carerix/match-placements — auto-match crew codes to Carerix jobs ────
router.post('/match-placements', async (req, res, next) => {
  try {
    const { autoMatchPlacementsCarerixIds } = await import('../services/carerix.js');
    const result = await autoMatchPlacementsCarerixIds();
    res.json(result);
  } catch (err) { next(err); }
});

// ── POST /carerix/gql-explore — explore Carerix GraphQL (agency only) ─────────
router.post('/gql-explore', requireAuth, requireAgency, async (req, res, next) => {
  try {
    const { query, variables } = req.body;
    if (!query) return res.status(400).json({ error: 'query required' });
    const { queryGraphQL } = await import('../services/carerix.js');
    const result = await queryGraphQL(query, variables || {});
    res.json(result);
  } catch (err) { next(err); }
});

// ── GET /carerix/rate-table/:id — fetch a specific Carerix rate table ─────────
router.get('/rate-table/:id', requireAuth, requireAgency, async (req, res, next) => {
  try {
    const { queryGraphQL } = await import('../services/carerix.js');
    const result = await queryGraphQL(`
      query RateTable($id: ID!) {
        crRateTable(id: $id) {
          _id
          name
          description
          crRateTableLines {
            _id
            amount
            validFrom
            validUntil
            description
          }
        }
      }
    `, { id: req.params.id });
    res.json(result);
  } catch (err) { next(err); }
});

// ── GET /carerix/placement-rates/:carerixPlacementId — rates for a placement ──
router.get('/placement-rates/:carerixPlacementId', requireAuth, requireAgency, async (req, res, next) => {
  try {
    const { queryGraphQL } = await import('../services/carerix.js');
    const result = await queryGraphQL(`
      query PlacementRates($id: ID!) {
        crMatch(id: $id) {
          _id
          toPublication { _id salary salaryMax }
          toCRRateTable { _id name crRateTableLines { _id amount validFrom validUntil description } }
          crMatchConditions {
            _id
            amount
            toCRRateTable { _id name crRateTableLines { _id amount validFrom validUntil description } }
          }
        }
      }
    `, { id: req.params.carerixPlacementId });
    res.json(result);
  } catch (err) { next(err); }
});

// ── POST /carerix/sync/company/:carerixCompanyID ──────────────────────────────
// Agency-only. Streams progress as newline-delimited JSON events so the
// frontend can show live progress without the 2-minute axios client timeout
// (Air Atlanta with ~hundreds of jobs can take several minutes).
//
// Event stream (one JSON object per line, \n-terminated):
//   { step: 'started', carerixCompanyID }
//   { step: 'heartbeat' }                 // every 10s
//   { step: 'company', ...companyRow }
//   { step: 'jobs_fetching' }
//   { step: 'jobs_fetched', total, active }
//   { step: 'placements_progress', done, total, created, updated }
//   { step: 'placement_error', jobID, error }
//   { step: 'placements_done', ...stats }
//   { step: 'users_fetching' }
//   { step: 'users_fetched', total }
//   { step: 'users_progress', done, total, created, updated }
//   { step: 'user_error', userID, error }
//   { step: 'users_done', ...stats }
//   { step: 'done', result }              // final success
//   { step: 'error', message, carerix? }  // terminal failure
router.post('/sync/company/:carerixCompanyID', requireAuth, requireAgency, async (req, res) => {
  const id = Number(req.params.carerixCompanyID);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'invalid carerixCompanyID', carerixCompanyID: req.params.carerixCompanyID });
  }
  res.setHeader('Content-Type',   'application/x-ndjson');
  res.setHeader('Cache-Control',  'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  const emit = (step, data = {}) => {
    try { res.write(JSON.stringify({ step, ts: Date.now(), ...data }) + '\n'); } catch (_e) { /* socket gone */ }
  };
  const heartbeat = setInterval(() => emit('heartbeat'), 10_000);
  res.on('close', () => clearInterval(heartbeat));

  try {
    const result = await syncCarerixCompany(id, emit);
    emit('done', { result });
  } catch (err) {
    emit('error', {
      message: err?.message || String(err),
      status:  err?.response?.status || err?.status || 500,
      carerix: err?.response?.data ?? null,
    });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

// ── GET /carerix/probe/jobs/:carerixCompanyID ─────────────────────────────────
// Agency-only. Returns the first 5 CRJob rows (raw) for a company so we can
// eyeball what Carerix actually sends for fields like startDate/endDate/status.
router.get('/probe/jobs/:carerixCompanyID', requireAuth, requireAgency, async (req, res, next) => {
  try {
    const id = Number(req.params.carerixCompanyID);
    if (!Number.isInteger(id) || id <= 0) throw new ApiError('invalid carerixCompanyID', 400);
    const { queryGraphQL } = await import('../services/carerix.js');
    const result = await queryGraphQL(`
      query ProbeJobs($qualifier: String, $pageable: Pageable) {
        crJobPage(qualifier: $qualifier, pageable: $pageable) {
          totalElements
          items {
            _id jobID name
            startDate endDate deleted status statusDisplay
            creationDate modificationDate forecastDate
            toStatusNode { _id value dataNodeID active notActive tag }
            toCompany { _id companyID name }
            toEmployee { _id employeeID firstName lastName }
          }
        }
      }
    `, {
      qualifier: `toCompany.companyID == ${id} AND deleted == 0`,
      pageable: { page: 0, size: 5 },
    }, { timeoutMs: 30_000 });
    res.json({
      carerixCompanyID: id,
      totalElements: result?.data?.crJobPage?.totalElements ?? null,
      sample: result?.data?.crJobPage?.items ?? [],
      errors: result?.errors ?? null,
    });
  } catch (err) {
    res.status(500).json({
      error: err?.message || String(err),
      carerix: err?.response?.data ?? null,
    });
  }
});

// ── GET /carerix/probe/jobs-schema ────────────────────────────────────────────
// Agency-only. Introspects the CRJob type so we can see every scalar/relation
// Carerix exposes — used to discover things like `jobActiveTag`.
router.get('/probe/jobs-schema', requireAuth, requireAgency, async (req, res) => {
  try {
    const { queryGraphQL } = await import('../services/carerix.js');
    const result = await queryGraphQL(`
      query JobSchema {
        __type(name: "CRJob") {
          name
          fields {
            name
            type {
              name kind
              ofType { name kind ofType { name kind } }
            }
          }
        }
      }
    `, {}, { timeoutMs: 30_000 });
    res.json({
      type: result?.data?.__type?.name ?? null,
      fields: result?.data?.__type?.fields ?? [],
      errors: result?.errors ?? null,
    });
  } catch (err) {
    res.status(500).json({
      error: err?.message || String(err),
      carerix: err?.response?.data ?? null,
    });
  }
});

// ── GET /carerix/probe/jobs-statuses/:carerixCompanyID ────────────────────────
// Agency-only. Pulls a wider page of jobs and reports the distribution of
// status / statusDisplay / toStatusNode.value so we can decide which states
// count as "active" before adding a status-based filter to the import.
router.get('/probe/jobs-statuses/:carerixCompanyID', requireAuth, requireAgency, async (req, res) => {
  try {
    const id = Number(req.params.carerixCompanyID);
    if (!Number.isInteger(id) || id <= 0) throw new ApiError('invalid carerixCompanyID', 400);
    const { queryGraphQL } = await import('../services/carerix.js');
    const result = await queryGraphQL(`
      query ProbeStatuses($qualifier: String, $pageable: Pageable) {
        crJobPage(qualifier: $qualifier, pageable: $pageable) {
          totalElements
          items {
            jobID status statusDisplay
            startDate endDate
            toStatusNode { _id value dataNodeID active notActive tag }
          }
        }
      }
    `, {
      qualifier: `toCompany.companyID == ${id} AND deleted == 0`,
      pageable: { page: 0, size: 500 },
    }, { timeoutMs: 60_000 });
    const items = result?.data?.crJobPage?.items ?? [];
    const todayStr = new Date().toISOString().split('T')[0];
    const parseYMD = v => { if (!v) return null; const m = String(v).match(/^(\d{4}-\d{2}-\d{2})/); return m ? m[1] : null; };
    const counts = new Map();
    for (const j of items) {
      const s = parseYMD(j?.startDate);
      const e = parseYMD(j?.endDate);
      const currentByDate =
        s && s <= todayStr && (!e || e >= todayStr);
      const key = JSON.stringify({
        status: j?.status ?? null,
        statusDisplay: j?.statusDisplay ?? null,
        nodeValue: j?.toStatusNode?.value ?? null,
        nodeActive: j?.toStatusNode?.active ?? null,
        nodeNotActive: j?.toStatusNode?.notActive ?? null,
        nodeTag: j?.toStatusNode?.tag ?? null,
        dataNodeID: j?.toStatusNode?.dataNodeID ?? null,
        currentByDate: Boolean(currentByDate),
      });
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const distribution = [...counts.entries()]
      .map(([k, count]) => ({ ...JSON.parse(k), count }))
      .sort((a, b) => b.count - a.count);
    res.json({
      carerixCompanyID: id,
      sampled: items.length,
      totalElements: result?.data?.crJobPage?.totalElements ?? null,
      distribution,
      errors: result?.errors ?? null,
    });
  } catch (err) {
    res.status(500).json({
      error: err?.message || String(err),
      carerix: err?.response?.data ?? null,
    });
  }
});

export default router;
