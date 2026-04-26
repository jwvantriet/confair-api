/**
 * Login probe — agency-only diagnostic that runs the full Carerix login +
 * identity lookup against supplied credentials, but writes nothing and
 * issues no session. Useful for support / onboarding triage.
 */

import { Router } from 'express';
import { adminSupabase } from '../services/supabase.js';
import { queryGraphQL, getCarerixCheckboxRegistry, fetchPlacementIdentityByCrUserId } from '../services/carerix.js';
import { requireAuth, requireAgency } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';
import { writeAuditLog } from '../utils/audit.js';
import { loginWithCarerix } from './auth.js';

const router = Router();

async function probeCompanyAccess(crUserId) {
  const out = {
    registryAvailable:     false,
    registryEntries:       0,
    additionalInfoKeysSet: [],
    decodedFunctionGroups: [],
    linkedCompanies:       [],
    unknownCompanies:      [],
  };
  const crUserIdNum = Number(crUserId);
  if (!Number.isFinite(crUserIdNum)) return out;

  let userResp, linksResp, registry;
  try {
    [userResp, linksResp, registry] = await Promise.all([
      queryGraphQL(`query CRUser($qualifier: String) { crUserPage(qualifier: $qualifier, pageable: { page: 0, size: 1 }) { items { _id userID additionalInfo } } }`, { qualifier: `userID == ${crUserIdNum}` }),
      queryGraphQL(`query UserCompanies($qualifier: String, $pageable: Pageable) { crUserCompanyPage(qualifier: $qualifier, pageable: $pageable) { totalElements items { _id toCompany { _id companyID name } } } }`, { qualifier: `toUser.userID == ${crUserIdNum}`, pageable: { page: 0, size: 100 } }),
      getCarerixCheckboxRegistry(),
    ]);
  } catch (err) {
    out.error = `carerix_unreachable: ${err.message}`;
    return out;
  }

  out.registryAvailable = registry !== null;
  out.registryEntries   = registry ? Object.keys(registry).length : 0;

  const additionalInfo = userResp?.data?.crUserPage?.items?.[0]?.additionalInfo || {};
  if (registry) {
    for (const [key, value] of Object.entries(additionalInfo)) {
      if (String(value).trim() !== '1') continue;
      const rawKey = key.startsWith('_') ? key.slice(1) : key;
      out.additionalInfoKeysSet.push(rawKey);
      const code = registry[rawKey];
      if (code) out.decodedFunctionGroups.push(code);
    }
  }

  const links = linksResp?.data?.crUserCompanyPage?.items || [];
  const carerixCompanies = links.map(l => l?.toCompany).filter(c => c?.companyID != null);
  const carerixCompanyIds = Array.from(new Set(carerixCompanies.map(c => String(c.companyID))));

  let resolvedRows = [];
  if (carerixCompanyIds.length) {
    const { data } = await adminSupabase.from('companies').select('id, name, carerix_company_id').in('carerix_company_id', carerixCompanyIds);
    resolvedRows = data || [];
  }
  const resolvedMap = new Map(resolvedRows.map(r => [r.carerix_company_id, r]));

  out.linkedCompanies = carerixCompanyIds.map(cid => {
    const carerixSrc = carerixCompanies.find(c => String(c.companyID) === cid);
    const platform   = resolvedMap.get(cid);
    return {
      carerixCompanyId:    cid,
      nameInCarerix:       carerixSrc?.name || null,
      platformCompanyId:   platform?.id   || null,
      platformCompanyName: platform?.name || null,
      imported:            !!platform,
    };
  });
  out.unknownCompanies = out.linkedCompanies.filter(c => !c.imported).map(c => c.carerixCompanyId);
  return out;
}

async function runLoginProbe(username, password) {
  const tStart  = Date.now();
  const timings = {};
  const warnings = [];

  const t1 = Date.now();
  let identity;
  try {
    identity = await loginWithCarerix(username, password);
  } catch (err) {
    timings.carerixRestLogin = Date.now() - t1;
    timings.total            = Date.now() - tStart;
    return { approved: false, error: { status: err.statusCode || err.status || 500, message: err.message || 'Login failed' }, timings };
  }
  timings.carerixRestLogin = Date.now() - t1;

  const result = {
    approved:          true,
    platformRole:      identity.platformRole,
    email:             identity.email,
    fullName:          identity.fullName,
    carerixUserId:     identity.carerixUserId,
    carerixCompanyId:  identity.carerixCompanyId,
    carerixEmployeeId: identity.carerixEmployeeId,
    userRoleIdInCarerix: identity.userRoleId,
    placement: null, company: null, agency: null, warnings,
  };

  if (identity.platformRole === 'placement') {
    const t2 = Date.now();
    const fg = await fetchPlacementIdentityByCrUserId(identity.carerixUserId);
    timings.placementLookup = Date.now() - t2;
    if (!fg) {
      warnings.push('No CREmployee linked to this CRUser; placement-scoped queries will return nothing.');
      result.placement = { found: false };
    } else {
      result.placement = {
        found: true,
        carerixEmployeeId: fg.employeeID,
        functionGroupLevel1: { id: fg.fgLevel1Id, code: fg.fgLevel1Code, name: fg.fgLevel1Name },
      };
      if (!fg.fgLevel1Id) warnings.push('Placement has no toFunction1Level1Node linked in Carerix — function-group scoping cannot match this user to any placements.');
    }
  } else if (identity.platformRole === 'agency_admin' || identity.platformRole === 'agency_operations') {
    result.agency = { note: 'Agency role — will see all companies and placements (no per-company access scoping).' };
  } else {
    const t2 = Date.now();
    const probe = await probeCompanyAccess(identity.carerixUserId);
    timings.companyAccessLookup = Date.now() - t2;
    result.company = probe;
    if (probe.error)                                              warnings.push(probe.error);
    if (!probe.registryAvailable)                                 warnings.push('Carerix checkbox registry could not be loaded — function groups cannot be decoded right now.');
    if (probe.registryAvailable && probe.registryEntries === 0)   warnings.push('Carerix checkbox registry is empty — there are no Attribute-contact CRDataNodes with tag=checkboxType. Function groups cannot be decoded.');
    if (probe.linkedCompanies.length === 0)                       warnings.push('No CRUserCompany links — this user will see no companies after login.');
    if (probe.unknownCompanies.length > 0)                        warnings.push(`${probe.unknownCompanies.length} Carerix company(s) linked to this user are NOT yet imported into the platform companies table; they will be invisible after login. Run syncCarerixCompany for: ${probe.unknownCompanies.join(', ')}`);
    if (probe.registryAvailable && probe.decodedFunctionGroups.length === 0 && probe.linkedCompanies.length > 0) warnings.push('No function-group checkboxes ticked on this CRUser — the user will be granted zero function groups (explicit deny) on each linked company.');
  }

  timings.total = Date.now() - tStart;
  return { ...result, timings };
}

router.post('/probe', requireAuth, requireAgency, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) throw new ApiError('username and password are required', 400);
    const probeResult = await runLoginProbe(username, password);
    await writeAuditLog({
      eventType:   'login_probe',
      actorUserId: req.user.id,
      actorRole:   req.user.role,
      payload: { probedUsername: username, approved: probeResult.approved, role: probeResult.platformRole || null, warnings: probeResult.warnings?.length || 0, totalMs: probeResult.timings?.total ?? null },
      ipAddress: req.ip,
    });
    res.json(probeResult);
  } catch (err) { next(err); }
});

export default router;
