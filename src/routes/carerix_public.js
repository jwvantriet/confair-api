/**
 * Carerix PUBLIC routes — no user auth, service token only
 */
import { Router } from 'express';
import { logger } from '../utils/logger.js';
const router = Router();

// ── GET /cx-pub/probe ─────────────────────────────────────────────────────────
router.get('/probe', async (req, res) => {
  const { queryGraphQL } = await import('../services/carerix.js');
  const r = {};
  const q = async (k, query, vars={}) => {
    try { const x = await queryGraphQL(query, vars); r[k] = x?.data || {errors: x?.errors}; }
    catch(e) { r[k] = 'ERR: ' + e.message.substring(0,80); }
  };

  await q('health',    '{ __typename }');
  await q('job',       'query J($id:ID!){ crJob(_id:$id){ _id jobID name additionalInfo toCompany{_id name companyID} toEmployee{_id employeeID} toOffice{_id name} toVacancy{ _id toCompany{_id name} } } }', { id: '5319' });

  // Employee 23593 — the contractor on this job
  await q('emp23593',  'query E($id:ID!){ crEmployee(_id:$id){ _id employeeID firstName lastName name paymentIbanCode paymentBicCode paymentAccountName homeFullAddress homeStreet homeNumber homeNumberSuffix homePostalCode homeCity toHomeCountryNode{value} } }', { id: '23593' });

  // Try to get office details — attempt multiple field names
  const officeId = r.job?.crJob?.toOffice?._id;
  if (officeId) {
    await q('office_basic', 'query O($id:ID!){ crOffice(_id:$id){ _id name } }', { id: officeId });
    await q('office_addr1', 'query O($id:ID!){ crOffice(_id:$id){ city postalCode street number toCountryNode{value} emailAddress phone } }', { id: officeId });
    await q('office_addr2', 'query O($id:ID!){ crOffice(_id:$id){ visitCity visitPostalCode visitStreet visitNumber vatNumber } }', { id: officeId });
    await q('office_addr3', 'query O($id:ID!){ crOffice(_id:$id){ homeCity homePostalCode homeStreet homeNumber toHomeCountryNode{value} } }', { id: officeId });
  }

  // Company address field attempts
  const compId = r.job?.crJob?.toCompany?._id || r.job?.crJob?.toVacancy?.toCompany?._id;
  if (compId) {
    await q('comp_basic', 'query C($id:ID!){ crCompany(_id:$id){ _id name } }', { id: compId });
    await q('comp_addr1', 'query C($id:ID!){ crCompany(_id:$id){ city postalCode street number toCountryNode{value} vatNumber emailAddress } }', { id: compId });
    await q('comp_addr2', 'query C($id:ID!){ crCompany(_id:$id){ visitCity visitPostalCode visitStreet visitNumber toVisitCountryNode{value} } }', { id: compId });
  }

  res.json(r);
});

// ── GET /cx-pub/invoice-data/:jobId ───────────────────────────────────────────
router.get('/invoice-data/:jobId', async (req, res) => {
  const { queryGraphQL } = await import('../services/carerix.js');
  const out = { job:null, employee:null, office:null, company:null, additionalInfo:{}, errors:{} };

  const safe = async (k, q, v={}) => {
    try { const r = await queryGraphQL(q, v); return r?.data || null; }
    catch(e) { out.errors[k] = e.message; return null; }
  };

  // 1. Job
  const jd = await safe('job',
    'query J($id:ID!){ crJob(_id:$id){ _id jobID name additionalInfo toCompany{_id name companyID} toEmployee{_id employeeID} toOffice{_id name} toVacancy{_id toCompany{_id name}} } }',
    { id: String(req.params.jobId) });
  out.job = jd?.crJob;
  if (!out.job) return res.json({ error: 'Job not found', raw: jd });

  // Parse additionalInfo
  for (const [k,v] of Object.entries(out.job.additionalInfo || {}))
    if (v != null && v !== '') out.additionalInfo[k.replace(/^_/,'')] = v;

  // 2. Employee (contractor — FROM)
  const empId = out.job.toEmployee?._id;
  if (empId) {
    const ed = await safe('emp',
      'query E($id:ID!){ crEmployee(_id:$id){ _id employeeID firstName lastName name paymentIbanCode paymentBicCode paymentAccountName homeFullAddress homeStreet homeNumber homeNumberSuffix homePostalCode homeCity toHomeCountryNode{value} } }',
      { id: String(empId) });
    out.employee = ed?.crEmployee;
  }

  // 3. Office (BILL TO — office linked to vacancy)
  // Try to get office via separate query (toOffice may not be on crJob directly)
  let officeId = null;
  const offQ = await safe('office_q', 'query J($id:ID!){ crJob(_id:$id){ toOffice{_id name} } }', { id: String(req.params.jobId) });
  officeId = offQ?.crJob?.toOffice?._id;
  if (!officeId) {
    const vacQ = await safe('vac_q', 'query J($id:ID!){ crJob(_id:$id){ toVacancy{ toOffice{_id name} toCompany{_id name} } } }', { id: String(req.params.jobId) });
    officeId = vacQ?.crJob?.toVacancy?.toOffice?._id;
  }
  if (officeId) {
    const od = await safe('office', 'query O($id:ID!){ crOffice(_id:$id){ _id name } }', { id: String(officeId) });
    out.office = od?.crOffice || null;
    // Try address fields
    for (const q of [
      'query O($id:ID!){ crOffice(_id:$id){ city postalCode street number toCountryNode{value} emailAddress vatNumber } }',
      'query O($id:ID!){ crOffice(_id:$id){ visitCity visitPostalCode visitStreet visitNumber toVisitCountryNode{value} } }',
      'query O($id:ID!){ crOffice(_id:$id){ homeCity homePostalCode homeStreet toHomeCountryNode{value} } }',
    ]) {
      const r = await safe('office_addr', q, { id: String(officeId) });
      if (r?.crOffice) { Object.assign(out.office, r.crOffice); break; }
    }
  }

  // 4. Company (fallback if no office)
  const compId = out.job.toCompany?._id || out.job.toVacancy?.toCompany?._id;
  if (compId && !out.office) {
    const cd = await safe('comp', 'query C($id:ID!){ crCompany(_id:$id){ _id name } }', { id: String(compId) });
    out.company = cd?.crCompany;
  }

  logger.info('cx-pub invoice-data', { jobId: req.params.jobId, empId, officeId, hasIban: !!out.employee?.paymentIbanCode });
  res.json(out);
});

export default router;
