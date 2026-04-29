/**
 * Diagnostic endpoint: inspect what Carerix's GraphQL API returns for the
 * `crJobFinancePage` query that drives charge rates during the RAIDO sync.
 *
 * Agency-only. No DB writes. Returns:
 *   - placement metadata (full_name, crew_id, carerix_job_id)
 *   - the exact GraphQL query and qualifier that was sent
 *   - the raw Carerix response (totalElements, items)
 *   - the decoded rateMap that the sync would build from it
 *   - a `claimCoverage`-style flag list that highlights which rate codes
 *     match charge_types in our DB
 */

import { Router } from 'express';
import { adminSupabase } from '../services/supabase.js';
import { queryGraphQL } from '../services/carerix.js';
import { requireAuth, requireAgency } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';
import { writeAuditLog } from '../utils/audit.js';

const router = Router();

// Mirror of the helper used by routes/roster.js — kept inline so the probe
// is independent of the sync code path (and any future drift).
function normalizeCurrency(raw) {
  if (!raw) return 'USD';
  const u = raw.toUpperCase().trim();
  if (u === 'EUR' || u.includes('EURO')) return 'EUR';
  if (u === 'USD' || u.includes('DOLLAR') || u.includes('US ')) return 'USD';
  if (u === 'GBP' || u.includes('POUND') || u.includes('STERLING')) return 'GBP';
  if (/^[A-Z]{3}$/.test(u)) return u;
  return 'USD';
}

const FINANCE_QUERY = `
  query JobFinancePage($qualifier: String, $pageable: Pageable) {
    crJobFinancePage(qualifier: $qualifier, pageable: $pageable) {
      totalElements
      items {
        _id
        toFinance {
          _id
          amount
          startDate
          endDate
          toKindNode { dataNodeID value }
          toCurrencyNode { dataNodeID value }
          toTypeNode { typeID }
        }
      }
    }
  }`;

router.post('/probe/job-finance', requireAuth, requireAgency, async (req, res, next) => {
  try {
    const { placementId } = req.body || {};
    if (!placementId) throw new ApiError('placementId is required', 400);

    const t0 = Date.now();

    const { data: placement } = await adminSupabase
      .from('placements')
      .select('id, full_name, crew_id, carerix_job_id, carerix_placement_id, company_id, start_date, end_date')
      .eq('id', placementId)
      .maybeSingle();

    if (!placement) throw new ApiError('Placement not found', 404);

    if (!placement.carerix_job_id) {
      return res.json({
        placement,
        sent: { query: FINANCE_QUERY, qualifier: null, reason: 'placement.carerix_job_id is null' },
        carerixResponse: null,
        rateMap: {},
        chargeTypeCoverage: {},
        timing: { totalMs: Date.now() - t0 },
      });
    }

    const qualifier = `toJob.jobID == ${parseInt(placement.carerix_job_id, 10)}`;

    let raw;
    try {
      raw = await queryGraphQL(FINANCE_QUERY, {
        qualifier,
        pageable: { page: 0, size: 100 },
      });
    } catch (err) {
      return res.json({
        placement,
        sent: { query: FINANCE_QUERY, qualifier },
        carerixResponse: null,
        error: { message: err.message },
        timing: { totalMs: Date.now() - t0 },
      });
    }

    const items = raw?.data?.crJobFinancePage?.items || [];
    const totalElements = raw?.data?.crJobFinancePage?.totalElements ?? items.length;

    // Decode rates (mirrors fetchCarerixRatesForJob in routes/roster.js)
    const rateMap = {};
    for (const item of items) {
      const finance = item?.toFinance;
      if (!finance) continue;
      const start  = finance.startDate ? String(finance.startDate).split('T')[0] : null;
      const end    = finance.endDate   ? String(finance.endDate).split('T')[0]   : null;
      const kindId = finance.toKindNode?.dataNodeID;
      if (!kindId) continue;
      const amount = finance.amount != null ? Number(finance.amount) : null;
      if (amount == null) continue;
      const currency = normalizeCurrency((finance.toCurrencyNode?.value || '').trim());
      const kindLabel = finance.toKindNode?.value || null;
      if (!rateMap[kindId]) rateMap[kindId] = { kindLabel, rates: [] };
      rateMap[kindId].rates.push({ amount, currency, start, end });
    }
    for (const k of Object.keys(rateMap)) {
      rateMap[k].rates.sort((a, b) => (a.start || '').localeCompare(b.start || ''));
    }

    // Map dataNodeIDs back to our charge_types so it's obvious which codes matched
    const { data: chargeTypes } = await adminSupabase
      .from('charge_types').select('id, code, label, carerix_type_id');
    const chargeTypeCoverage = (chargeTypes || []).reduce((acc, ct) => {
      const matched = ct.carerix_type_id ? rateMap[ct.carerix_type_id] : null;
      acc[ct.code] = {
        carerix_type_id:  ct.carerix_type_id,
        matchedFromCarerix: !!matched,
        kindLabel:        matched?.kindLabel || null,
        rateCount:        matched?.rates?.length || 0,
      };
      return acc;
    }, {});

    await writeAuditLog({
      eventType:   'finance_probe',
      actorUserId: req.user.id,
      actorRole:   req.user.role,
      payload: {
        placementId, crew_id: placement.crew_id,
        carerix_job_id: placement.carerix_job_id,
        totalElements,
        rateKindCount: Object.keys(rateMap).length,
      },
      ipAddress: req.ip,
    }).catch(() => { /* swallow */ });

    res.json({
      placement,
      sent: { query: FINANCE_QUERY, qualifier },
      carerixResponse: {
        totalElements,
        items, // raw items so we can see exactly what Carerix returns
      },
      rateMap,
      chargeTypeCoverage,
      timing: { totalMs: Date.now() - t0 },
    });
  } catch (err) { next(err); }
});

export default router;
