/**
 * Carerix PUBLIC routes — no user auth, service token only
 * Confirmed working fields (from debug session):
 *   crAgency(_id)  → name, visitFullAddress, visitCity, visitCityCode, visitPostalCode
 *   crEmployee(_id) → firstName, lastName, paymentIbanCode, paymentBicCode,
 *                     paymentAccountName, homeFullAddress, homePostalCode, homeCity,
 *                     toHomeCountryNode{value}
 *   crJob(_id)     → _id, jobID, name, additionalInfo, toEmployee{_id}, toCompany{_id name}
 *                     (each as separate query — combining with additionalInfo causes 400)
 */
import { Router } from 'express';
import { logger }  from '../utils/logger.js';
const router = Router();

const gql = async (q, v = {}) => {
  const { queryGraphQL } = await import('../services/carerix.js');
  try   { return await queryGraphQL(q, v); }
  catch (e) { return { error: e.message }; }
};

// ── GET /cx-pub/probe ─────────────────────────────────────────────────────────
router.get('/probe', async (req, res) => {
  const r = {};
  const q = async (k, query, vars = {}) => { const x = await gql(query, vars); r[k] = x?.data || x; };

  await q('health',   '{ __typename }');
  await q('agency6',  'query A($id:ID!){ crAgency(_id:$id){ _id name visitFullAddress visitCity visitCityCode visitPostalCode } }', { id: '6' });
  await q('emp23593', 'query E($id:ID!){ crEmployee(_id:$id){ _id firstName lastName paymentIbanCode paymentBicCode paymentAccountName homeFullAddress homePostalCode homeCity toHomeCountryNode{value} } }', { id: '23593' });
  await q('job5319',  'query J($id:ID!){ crJob(_id:$id){ _id jobID name } }', { id: '5319' });
  await q('job5319_emp', 'query J($id:ID!){ crJob(_id:$id){ toEmployee{_id employeeID} } }', { id: '5319' });

  res.json(r);
});

// ── GET /cx-pub/schema/:type ──────────────────────────────────────────────────
router.get('/schema/:type', async (req, res) => {
  const result = await gql(
    'query T($name:String!){ __type(name:$name){ name fields{ name type{ name kind ofType{name kind} } } } }',
    { name: req.params.type }
  );
  res.json(result);
});

// ── GET /cx-pub/raw — ad-hoc field test ───────────────────────────────────────
// Usage: /cx-pub/raw?type=crAgency&id=6&fields=visitFullAddress,visitCity
router.get('/raw', async (req, res) => {
  const { type, id, fields } = req.query;
  if (!type || !id || !fields) return res.status(400).json({ error: 'need type, id, fields' });
  const query = `query Q($id:ID!){ ${type}(_id:$id){ ${fields} } }`;
  const result = await gql(query, { id: String(id) });
  res.json({ query, result });
});

// ── GET /cx-pub/invoice-data/:jobId ───────────────────────────────────────────
router.get('/invoice-data/:jobId', async (req, res) => {
  const out = { job: null, employee: null, office: null, additionalInfo: {}, errors: {} };
  const safe = async (k, q, v = {}) => {
    const r = await gql(q, v);
    if (r.error) { out.errors[k] = r.error; return null; }
    return r?.data || null;
  };

  // Job — split into separate queries (combining additionalInfo with relations = 400)
  const jBasic = await safe('job', 'query J($id:ID!){ crJob(_id:$id){ _id jobID name } }', { id: String(req.params.jobId) });
  out.job = jBasic?.crJob || null;
  if (!out.job) return res.json({ error: 'Job not found', errors: out.errors });

  const [jAI, jEmp] = await Promise.all([
    safe('ai',  'query J($id:ID!){ crJob(_id:$id){ additionalInfo } }', { id: String(req.params.jobId) }),
    safe('emp', 'query J($id:ID!){ crJob(_id:$id){ toEmployee{_id employeeID} } }', { id: String(req.params.jobId) }),
  ]);

  for (const [k, v] of Object.entries(jAI?.crJob?.additionalInfo || {}))
    if (v != null && v !== '') out.additionalInfo[k.replace(/^_/, '')] = v;

  const empId = jEmp?.crJob?.toEmployee?._id;
  if (empId) {
    const ed = await safe('employee',
      'query E($id:ID!){ crEmployee(_id:$id){ _id firstName lastName name paymentIbanCode paymentBicCode paymentAccountName homeFullAddress homePostalCode homeCity toHomeCountryNode{value} } }',
      { id: String(empId) });
    out.employee = ed?.crEmployee || null;
  }

  // Agency passed as query param (job→agency not queryable via GraphQL)
  const agencyId = req.query.agencyId;
  if (agencyId) {
    const ad = await safe('agency',
      'query A($id:ID!){ crAgency(_id:$id){ _id name visitFullAddress visitCity visitCityCode visitPostalCode } }',
      { id: String(agencyId) });
    out.office = ad?.crAgency || null;
  }

  logger.info('cx-pub invoice-data', { jobId: req.params.jobId, empId, agencyId, hasIban: !!out.employee?.paymentIbanCode });
  res.json(out);
});

export default router;
