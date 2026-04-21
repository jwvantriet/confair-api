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

router.get('/test', async (req, res) => {
  const results = await testCarerixConnection();
  res.json(results);
});

router.get('/inspect-login', async (req, res) => {
  const { u, p } = req.query;
  if (!u || !p) return res.status(400).json({ error: 'Pass ?u=username&p=md5password' });
  const restBase = config.carerix.restUrl;
  const restAuth = Buffer.from(`${config.carerix.restUsername}:${config.carerix.restPassword}`).toString('base64');
  const headers  = { Authorization: `Basic ${restAuth}`, 'User-Agent': 'confair-platform/1.0' };
  const results = {};
  const showVariants = ['', 'userRoleID', 'userRoleID,toEmployee,toContact,toCompany,firstName,lastName', 'groups', 'toEmployee,toContact,toCompany,toUserRole'];
  for (const show of showVariants) {
    const params = { u, p };
    if (show) params.show = show;
    try {
      const r = await axios.get(`${restBase}CRUser/login-with-encrypted-password`, { params, headers, timeout: 10_000, responseType: 'text' });
      results[`show=${show || '(none)'}`] = { raw: r.data?.substring(0, 1000), parsed: parseXml(r.data) };
    } catch (e) { results[`show=${show || '(none)'}`] = { error: e.message, status: e.response?.status }; }
  }
  const crUserId = parseXml((await axios.get(`${restBase}CRUser/login-with-encrypted-password`, { params: { u, p }, headers, timeout: 10_000, responseType: 'text' }).catch(() => ({ data: '' }))).data)?.CRUser?.['@_id'];
  if (crUserId) {
    for (const show of ['', 'groups', 'toEmployee,toContact,toCompany,toUserRole,userRoleID']) {
      const params = {}; if (show) params.show = show;
      try { const r = await axios.get(`${restBase}CRUser/${crUserId}`, { params, headers, timeout: 8_000, responseType: 'text' }); results[`CRUser/${crUserId} show=${show || '(none)'}`] = { raw: r.data?.substring(0, 1000), parsed: parseXml(r.data) }; }
      catch (e) { results[`CRUser/${crUserId} show=${show || '(none)'}`] = { error: e.message }; }
    }
    try { const r = await axios.get(`${restBase}CREmployee`, { params: { qualifier: `toUser._id = ${crUserId}`, show: 'groups', limit: 1 }, headers, timeout: 8_000, responseType: 'text' }); results[`CREmployee qualifier toUser._id show=groups`] = { raw: r.data?.substring(0, 500) }; }
    catch (e) { results[`CREmployee qualifier toUser._id`] = { error: e.message, status: e.response?.status }; }
  }
  res.json({ crUserId, results });
});

router.get('/invoice-data/:jobId', async (req, res, next) => {
  try {
    const { queryGraphQL } = await import('../services/carerix.js');
    const jobResult = await queryGraphQL(`query JobDetail($id: ID!) { crJob(_id: $id) { _id jobID name additionalInfo additionalInfoList toCompany { _id companyID name } toEmployee { _id employeeID } } }`, { id: String(req.params.jobId) });
    const job = jobResult?.data?.crJob;
    if (!job) return res.json({ error: 'Job not found', raw: jobResult });
    const empId = job.toEmployee?._id;
    let employee = null;
    if (empId) { const r = await queryGraphQL(`query EmpDetail($id: ID!) { crEmployee(_id: $id) { _id employeeID firstName lastName name paymentIbanCode paymentBicCode paymentAccountName homeFullAddress homeStreet homeNumber homeNumberSuffix homePostalCode homeCity toHomeCountryNode { value } } }`, { id: String(empId) }); employee = r?.data?.crEmployee; }
    const compId = job.toCompany?._id;
    let company = null;
    if (compId) { const r = await queryGraphQL(`query CompDetail($id: ID!) { crCompany(_id: $id) { _id companyID name visitCity visitPostalCode visitStreet visitNumber toVisitCountryNode { value } emailAddress phone vatNumber } }`, { id: String(compId) }); company = r?.data?.crCompany; }
    const ai = {}; const rawAI = job.additionalInfo || job.additionalInfoList || {};
    if (typeof rawAI === 'object') { for (const [k, v] of Object.entries(rawAI)) { ai[k.replace(/^_/, '')] = v; } }
    res.json({ job, employee, company, additionalInfo: ai });
  } catch (err) { next(err); }
});

router.get('/employee-finances/:employeeId', async (req, res, next) => {
  try {
    const { queryGraphQL } = await import('../services/carerix.js');
    const result = await queryGraphQL(`query EmployeeFinancePage($qualifier: String, $pageable: Pageable) { crEmployeeFinancePage(qualifier: $qualifier, pageable: $pageable) { items { _id toFinance { _id startDate endDate amount cost info toKindNode { dataNodeID value } toCurrencyNode { dataNodeID value } toTypeNode { typeID identifier } } } } }`, { qualifier: 'toEmployee.employeeID == ' + req.params.employeeId, pageable: { page: 0, size: 100 } });
    res.json(result);
  } catch (err) { next(err); }
});

router.get('/job-finances/:jobId', async (req, res, next) => {
  try {
    const { queryGraphQL } = await import('../services/carerix.js');
    const result = await queryGraphQL(`query JobFinancePage($qualifier: String, $pageable: Pageable) { crJobFinancePage(qualifier: $qualifier, pageable: $pageable) { items { _id toJob { _id jobID name } toFinance { _id startDate endDate amount cost info toKindNode { dataNodeID value } toCurrencyNode { dataNodeID value } toTypeNode { typeID identifier } } } } }`, { qualifier: 'toJob.jobID == ' + req.params.jobId, pageable: { page: 0, size: 100 } });
    res.json(result);
  } catch (err) { next(err); }
});

router.get('/probe', async (req, res, next) => {
  try {
    const { queryGraphQL } = await import('../services/carerix.js');
    const results = {};
    try { const r = await queryGraphQL('{ __typename }', {}); results.introspection = r?.data || r?.errors?.[0]?.message || 'no data'; } catch(e) { results.introspection = 'ERROR: ' + e.message; }
    try { const r = await queryGraphQL('query { crJob(_id: "5319") { _id jobID name } }', {}); results.crJob_id = r?.data?.crJob || r?.errors?.[0]?.message || 'null'; } catch(e) { results.crJob_id = 'ERROR: ' + e.message; }
    try { const r = await queryGraphQL('query { crJob(_id: "5319") { additionalInfo } }', {}); results.additionalInfo_5319 = r?.data?.crJob || r?.errors?.[0]?.message || 'null'; } catch(e) { results.additionalInfo_5319 = 'ERROR: ' + e.message; }
    try { const r = await queryGraphQL('query { crJob(_id: "5319") { toCompany { _id name companyID } toEmployee { _id employeeID } } }', {}); results.jobRelations = r?.data?.crJob || r?.errors?.[0]?.message || 'null'; } catch(e) { results.jobRelations = 'ERROR: ' + e.message; }
    res.json(results);
  } catch (err) { next(err); }
});

// ── GET /carerix/crew-code-probe — debug crew code → job matching ─────────────
// No auth required. Shows additionalInfo[10189] on jobs and what buildCrewCodeToJobMap returns.
router.get('/crew-code-probe', async (req, res, next) => {
  try {
    const { queryGraphQL, buildCrewCodeToJobMap } = await import('../services/carerix.js');
    const out = {};

    // 1. Sample 5 jobs — show additionalInfo to confirm field 10189 contains crew code
    try {
      const r = await queryGraphQL(`
        query {
          crJobPage(pageable: { page: 0, size: 5 }) {
            totalElements
            items { _id jobID name additionalInfo }
          }
        }
      `, {});
      out.job_sample = r?.data?.crJobPage ?? r?.errors ?? 'no data';
    } catch(e) { out.job_sample = 'ERROR: ' + e.message; }

    // 2. Look at ERIC's job specifically — confirm 10189 = "ERIC"
    try {
      const r = await queryGraphQL(`
        query { crJob(_id: "5319") { _id jobID name additionalInfo } }
      `, {});
      out.eric_job_5319 = r?.data?.crJob ?? r?.errors ?? 'null';
      // Extract field 10189 explicitly
      const ai = out.eric_job_5319?.additionalInfo;
      out.eric_field_10189 = ai ? (ai['10189'] ?? ai['_10189'] ?? 'KEY_NOT_FOUND') : 'NO_ADDITIONALINFO';
    } catch(e) { out.eric_job_5319 = 'ERROR: ' + e.message; }

    // 3. Run the map builder
    try {
      const map = await buildCrewCodeToJobMap();
      out.crew_code_map    = map;
      out.crew_codes_found = Object.keys(map);
      out.dagf_found       = 'DAGF' in map;
      out.eric_found       = 'ERIC' in map;
    } catch(e) { out.crew_code_map = 'ERROR: ' + e.message; }

    res.json(out);
  } catch (err) { next(err); }
});

// ── Protected routes ──────────────────────────────────────────────────────────
router.use(requireAuth, requireAgency);

router.post('/sync/fees/:periodId', async (req, res, next) => {
  try {
    const { data: entries } = await adminSupabase.from('declaration_entries').select('id, entry_date, imported_amount, fee_retrieval_status, declaration_types(code), placements(placement_ref), companies(company_ref)').eq('payroll_period_id', req.params.periodId).eq('fee_retrieval_status', 'pending');
    if (!entries?.length) return res.json({ message: 'No pending fee retrievals', count: 0 });
    let retrieved = 0, failed = 0;
    for (const entry of entries) {
      const result = await fetchAndCacheFee(entry.placements.placement_ref, entry.companies.company_ref, entry.declaration_types.code, entry.entry_date);
      if (result?.retrieval_status === 'retrieved') { await adminSupabase.from('declaration_entries').update({ fee_cache_id: result.id, fee_amount: result.fee_amount, fee_retrieval_status: 'retrieved', calculated_value: entry.imported_amount * result.fee_amount, status: 'fee_retrieved' }).eq('id', entry.id); retrieved++; }
      else { await adminSupabase.from('declaration_entries').update({ fee_retrieval_status: 'failed', status: 'fee_retrieval_failed' }).eq('id', entry.id); failed++; }
    }
    res.json({ message: 'Fee sync complete', retrieved, failed, total: entries.length });
  } catch (err) { next(err); }
});

router.get('/fees/status/:periodId', async (req, res, next) => {
  try {
    const { data, error } = await adminSupabase.from('declaration_entries').select('fee_retrieval_status').eq('payroll_period_id', req.params.periodId);
    if (error) throw new ApiError(error.message);
    const summary = data.reduce((acc, row) => { acc[row.fee_retrieval_status] = (acc[row.fee_retrieval_status] || 0) + 1; return acc; }, {});
    res.json(summary);
  } catch (err) { next(err); }
});

router.post('/match-placements', async (req, res, next) => {
  try {
    const { autoMatchPlacementsCarerixIds } = await import('../services/carerix.js');
    const result = await autoMatchPlacementsCarerixIds();
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/gql-explore', requireAuth, requireAgency, async (req, res, next) => {
  try {
    const { query, variables } = req.body;
    if (!query) return res.status(400).json({ error: 'query required' });
    const { queryGraphQL } = await import('../services/carerix.js');
    const result = await queryGraphQL(query, variables || {});
    res.json(result);
  } catch (err) { next(err); }
});

router.get('/rate-table/:id', requireAuth, requireAgency, async (req, res, next) => {
  try {
    const { queryGraphQL } = await import('../services/carerix.js');
    const result = await queryGraphQL(`query RateTable($id: ID!) { crRateTable(id: $id) { _id name description crRateTableLines { _id amount validFrom validUntil description } } }`, { id: req.params.id });
    res.json(result);
  } catch (err) { next(err); }
});

router.get('/placement-rates/:carerixPlacementId', requireAuth, requireAgency, async (req, res, next) => {
  try {
    const { queryGraphQL } = await import('../services/carerix.js');
    const result = await queryGraphQL(`query PlacementRates($id: ID!) { crMatch(id: $id) { _id toPublication { _id salary salaryMax } toCRRateTable { _id name crRateTableLines { _id amount validFrom validUntil description } } crMatchConditions { _id amount toCRRateTable { _id name crRateTableLines { _id amount validFrom validUntil description } } } } }`, { id: req.params.carerixPlacementId });
    res.json(result);
  } catch (err) { next(err); }
});

export default router;
