/**
 * Carerix PUBLIC debug routes — no user auth, service token only
 */
import { Router } from 'express';
import { logger } from '../utils/logger.js';
const router = Router();

const gql = async (query, vars = {}) => {
  const { queryGraphQL } = await import('../services/carerix.js');
  try { return await queryGraphQL(query, vars); }
  catch(e) { return { error: e.message }; }
};

// ── GET /cx-pub/schema/:type — introspect a GraphQL type ─────────────────────
router.get('/schema/:type', async (req, res) => {
  const result = await gql(`
    query TypeInfo($name: String!) {
      __type(name: $name) {
        name
        fields {
          name
          type { name kind ofType { name kind } }
        }
      }
    }
  `, { name: req.params.type });
  res.json(result);
});

// ── GET /cx-pub/raw — run a raw query with field list ─────────────────────────
// Usage: /cx-pub/raw?type=crJob&id=418&fields=_id,jobID,name,additionalInfo
router.get('/raw', async (req, res) => {
  const { type, id, fields } = req.query;
  if (!type || !id || !fields) return res.status(400).json({ error: 'need type, id, fields params' });
  const query = `query Q($id:ID!){ ${type}(_id:$id){ ${fields} } }`;
  logger.info('cx-pub raw', { query });
  const result = await gql(query, { id: String(id) });
  res.json({ query, result });
});

// ── GET /cx-pub/probe — comprehensive debug of job 418 + office 6 ─────────────
router.get('/probe', async (req, res) => {
  const r = {};
  const q = async (k, query, vars = {}) => {
    const x = await gql(query, vars);
    r[k] = x?.data || x;
  };

  // 1. Health
  await q('health', '{ __typename }');

  // 2. Job 418 — minimal first
  await q('job418_min',    'query J($id:ID!){ crJob(_id:$id){ _id jobID name } }', { id: '418' });
  await q('job418_emp',    'query J($id:ID!){ crJob(_id:$id){ toEmployee{_id employeeID} } }', { id: '418' });
  await q('job418_comp',   'query J($id:ID!){ crJob(_id:$id){ toCompany{_id name companyID} } }', { id: '418' });
  await q('job418_ai',     'query J($id:ID!){ crJob(_id:$id){ additionalInfo } }', { id: '418' });
  await q('job418_office', 'query J($id:ID!){ crJob(_id:$id){ toOffice{_id name} } }', { id: '418' });

  // 3. Office 6 — introspect available fields
  await q('office6_name',  'query O($id:ID!){ crOffice(_id:$id){ _id name } }', { id: '6' });

  // Test every plausible address field individually
  for (const field of ['city','postalCode','street','number','emailAddress','vatNumber',
    'visitCity','visitCityCode','visitPostalCode','visitStreet','visitNumber','visitFullAddress',
    'homeCity','homePostalCode','homeStreet','homeNumber','homeFullAddress']) {
    await q(`off6_${field}`, `query O($id:ID!){ crOffice(_id:$id){ ${field} } }`, { id: '6' });
  }

  // Country nodes
  await q('off6_visitCountry', 'query O($id:ID!){ crOffice(_id:$id){ toVisitCountryNode{value} } }', { id: '6' });
  await q('off6_homeCountry',  'query O($id:ID!){ crOffice(_id:$id){ toHomeCountryNode{value} } }', { id: '6' });
  await q('off6_country',      'query O($id:ID!){ crOffice(_id:$id){ toCountryNode{value} } }', { id: '6' });

  // 4. Employee 23593
  await q('emp23593', 'query E($id:ID!){ crEmployee(_id:$id){ _id firstName lastName paymentIbanCode paymentBicCode paymentAccountName homeFullAddress homePostalCode homeCity toHomeCountryNode{value} } }', { id: '23593' });

  res.json(r);
});

// ── GET /cx-pub/invoice-data/:jobId ───────────────────────────────────────────
router.get('/invoice-data/:jobId', async (req, res) => {
  const out = { job: null, employee: null, office: null, additionalInfo: {}, errors: {} };
  const safe = async (k, q, v = {}) => {
    const r = await gql(q, v);
    if (r.error) { out.errors[k] = r.error; return null; }
    return r?.data || null;
  };

  // Query fields separately — Carerix 400s when combining additionalInfo with relations
  const jBasic = await safe('job_basic', 'query J($id:ID!){ crJob(_id:$id){ _id jobID name } }', { id: String(req.params.jobId) });
  if (!jBasic?.crJob) return res.json({ error: 'Job not found', raw: jBasic, errors: out.errors });
  out.job = jBasic.crJob;

  const jAI  = await safe('job_ai',   'query J($id:ID!){ crJob(_id:$id){ additionalInfo } }', { id: String(req.params.jobId) });
  const jEmp = await safe('job_emp',  'query J($id:ID!){ crJob(_id:$id){ toEmployee{_id employeeID} } }', { id: String(req.params.jobId) });

  for (const [k, v] of Object.entries(jAI?.crJob?.additionalInfo || {}))
    if (v != null && v !== '') out.additionalInfo[k.replace(/^_/, '')] = v;

  const empId = jEmp?.crJob?.toEmployee?._id;
  if (empId) {
    const ed = await safe('emp', 'query E($id:ID!){ crEmployee(_id:$id){ _id firstName lastName name paymentIbanCode paymentBicCode paymentAccountName homeFullAddress homePostalCode homeCity toHomeCountryNode{value} } }', { id: String(empId) });
    out.employee = ed?.crEmployee || null;
  }

  const offQ = await safe('office_link', 'query J($id:ID!){ crJob(_id:$id){ toOffice{_id name} } }', { id: String(req.params.jobId) });
  logger.info('office_link result', { offQ: JSON.stringify(offQ) });
  const officeId = offQ?.crJob?.toOffice?._id;
  if (officeId) {
    out.office = { _id: officeId, name: offQ.crJob.toOffice.name };
    // Only use confirmed working fields
    const oa = await safe('office_addr',
      'query O($id:ID!){ crOffice(_id:$id){ visitCityCode visitPostalCode visitStreet visitNumber toVisitCountryNode{value} vatNumber emailAddress } }',
      { id: String(officeId) });
    if (oa?.crOffice) Object.assign(out.office, oa.crOffice);
  }

  res.json(out);
});

export default router;
