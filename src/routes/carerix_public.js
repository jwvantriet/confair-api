/**
 * Carerix PUBLIC routes — no user auth required, uses service token only
 * Registered at /cx-pub in index.js
 */
import { Router } from 'express';
import { logger } from '../utils/logger.js';

const router = Router();

// ── GET /cx-pub/probe — field-by-field diagnostic ─────────────────────────────
router.get('/probe', async (req, res) => {
  try {
    const { queryGraphQL } = await import('../services/carerix.js');
    const results = {};

    const q = async (name, query, vars = {}) => {
      try {
        const r = await queryGraphQL(query, vars);
        results[name] = r?.data || { errors: r?.errors };
      } catch(e) { results[name] = 'ERROR: ' + e.message; }
    };

    await q('introspection',  '{ __typename }');
    await q('crJob_basic',    'query J($id:ID!){ crJob(_id:$id){ _id jobID name } }', { id: '5319' });
    await q('crJob_addInfo',  'query J($id:ID!){ crJob(_id:$id){ additionalInfo additionalInfoList } }', { id: '5319' });
    await q('crJob_company',  'query J($id:ID!){ crJob(_id:$id){ toCompany{ _id name companyID } toEmployee{ _id employeeID } } }', { id: '5319' });
    await q('crEmployee_14',  'query E($id:ID!){ crEmployee(_id:$id){ _id employeeID firstName lastName homeCity homePostalCode homeFullAddress homeStreet homeNumber paymentIbanCode paymentBicCode paymentAccountName toHomeCountryNode{ value } } }', { id: '14' });

    // Try company fields once we know the company _id
    const compId = results?.crJob_company?.crJob?.toCompany?._id;
    if (compId) {
      await q('crCompany', `query C($id:ID!){ crCompany(_id:$id){ _id name visitCity visitPostalCode visitStreet visitNumber toVisitCountryNode{ value } vatNumber } }`, { id: compId });
    }

    res.json(results);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /cx-pub/invoice-data/:jobId — all invoice data via service token ──────
router.get('/invoice-data/:jobId', async (req, res) => {
  try {
    const { queryGraphQL } = await import('../services/carerix.js');
    const jobId = req.params.jobId;

    const jobRes = await queryGraphQL(
      'query J($id:ID!){ crJob(_id:$id){ _id jobID name additionalInfo additionalInfoList toCompany{ _id companyID name } toEmployee{ _id employeeID } } }',
      { id: String(jobId) }
    );
    const job = jobRes?.data?.crJob;
    if (!job) return res.json({ error: 'Job not found', raw: jobRes });

    let employee = null;
    if (job.toEmployee?._id) {
      const r = await queryGraphQL(
        'query E($id:ID!){ crEmployee(_id:$id){ _id employeeID firstName lastName name paymentIbanCode paymentBicCode paymentAccountName homeFullAddress homeStreet homeNumber homeNumberSuffix homePostalCode homeCity toHomeCountryNode{ value } } }',
        { id: String(job.toEmployee._id) }
      );
      employee = r?.data?.crEmployee;
    }

    let cxCompany = null;
    if (job.toCompany?._id) {
      const r = await queryGraphQL(
        'query C($id:ID!){ crCompany(_id:$id){ _id name visitCity visitPostalCode visitStreet visitNumber toVisitCountryNode{ value } vatNumber } }',
        { id: String(job.toCompany._id) }
      );
      cxCompany = r?.data?.crCompany;
    }

    // Parse additionalInfo
    const ai = {};
    const rawAI = job.additionalInfo || {};
    if (typeof rawAI === 'object') {
      for (const [k, v] of Object.entries(rawAI)) {
        if (v != null && v !== '') ai[k.replace(/^_/, '')] = v;
      }
    }
    for (const item of job.additionalInfoList || []) {
      if (item?.id && item?.value) ai[String(item.id)] = item.value;
    }

    logger.info('cx-pub invoice-data', { jobId, empId: job.toEmployee?._id, compId: job.toCompany?._id, aiKeys: Object.keys(ai) });
    res.json({ job, employee, cxCompany, additionalInfo: ai });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
