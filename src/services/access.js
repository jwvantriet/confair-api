/**
 * Company-access helpers — single source of truth for "which companies can
 * this user see" now that a user may have access to multiple companies via
 * the user_company_access junction table.
 *
 * Call `companyIdsForUser(user)` and filter downstream queries with
 *   .in('company_id', ids)   (or the placement_id equivalent)
 *
 * Return semantics:
 *   null  → agency role, no filter (sees every company)
 *   []    → authenticated non-agency with zero companies linked (show nothing)
 *   [...] → concrete list of company uuids
 */
import { adminSupabase } from './supabase.js';
import { queryGraphQL, getCarerixCheckboxRegistry } from './carerix.js';
import { logger } from '../utils/logger.js';

/** @returns {Promise<null | string[]>} */
export async function companyIdsForUser(user) {
  if (!user) return [];
  if (user.role?.startsWith('agency_')) return null;

  // Primary: the junction table
  const { data: access } = await adminSupabase
    .from('user_company_access')
    .select('company_id')
    .eq('user_profile_id', user.id);
  const ids = (access || []).map(r => r.company_id);
  if (ids.length) return ids;

  // Fallback for users whose access isn't filled in yet (pre-migration state)
  if (user.carerix_company_id) {
    const { data: c } = await adminSupabase
      .from('companies').select('id')
      .eq('carerix_company_id', user.carerix_company_id)
      .maybeSingle();
    if (c) return [c.id];
  }
  return [];
}

/**
 * Returns the full access rule set for a non-agency user:
 *   [{ company_id, function_groups }]
 * function_groups is null = "all groups", or an array of group names.
 *
 * For agency roles returns null (= no restriction).
 *
 * When a user has only the legacy `carerix_company_id` on their profile and
 * no user_company_access rows yet, we synthesize a single rule with
 * function_groups=null (all groups) for that company.
 *
 * @returns {Promise<null | Array<{company_id: string, function_groups: string[] | null}>>}
 */
export async function accessRulesForUser(user) {
  if (!user) return [];
  if (user.role?.startsWith('agency_')) return null;

  const { data: rows } = await adminSupabase
    .from('user_company_access')
    .select('company_id, function_groups')
    .eq('user_profile_id', user.id);
  if (rows && rows.length) return rows;

  // Legacy fallback — single company, unrestricted.
  if (user.carerix_company_id) {
    const { data: c } = await adminSupabase
      .from('companies').select('id')
      .eq('carerix_company_id', user.carerix_company_id)
      .maybeSingle();
    if (c) return [{ company_id: c.id, function_groups: null }];
  }
  return [];
}

/**
 * Filters a list of placements down to only those that match the user's
 * per-company function_groups scope. Expects each placement to have
 * `company_id` and `carerix_function_group_id` fields. The rule's
 * function_groups array holds function_group IDs (as strings) — these match
 * the Carerix CRDataNode exportCode decoded at login.
 *
 * If rules is null (agency), returns the list unchanged.
 * If a placement's company has function_groups=null in rules, all groups pass.
 * If function_groups is an array, only matching group IDs pass.
 * Placements whose company is not in the ruleset are filtered out.
 */
export function filterPlacementsByAccessRules(placements, rules) {
  if (!Array.isArray(placements)) return [];
  if (rules === null) return placements;
  const byCompany = new Map();
  for (const r of rules || []) byCompany.set(r.company_id, r.function_groups);
  return placements.filter(p => {
    if (!byCompany.has(p.company_id)) return false;
    const groups = byCompany.get(p.company_id);
    if (groups === null || groups === undefined) return true;
    if (!Array.isArray(groups) || groups.length === 0) return false;
    return groups.includes(String(p.carerix_function_group_id));
  });
}

/**
 * Sync a user's `user_company_access` rows from their live Carerix state.
 *
 * Runs three queries in parallel:
 *   1. crUserPage        — for CRUser.additionalInfo (checkbox values)
 *   2. crUserCompanyPage — for linked CRCompanies
 *   3. getCarerixCheckboxRegistry — dataNodeID → exportCode map
 *
 * Decodes additionalInfo keys whose value is "1" via the registry into a
 * function_groups array (the exportCode matches a placement's
 * carerix_function_group_id). Upserts one user_company_access row per linked
 * company with that same array. Companies that Carerix no longer links to
 * this user are deleted (user-scoped orphan cleanup — never touches other
 * users' rows).
 *
 * Carerix companies that have not yet been imported into our `companies`
 * table are logged and skipped — admins must run syncCarerixCompany for them.
 *
 * @returns {Promise<{
 *   synced:         number,
 *   unknown:        string[],
 *   functionGroups: string[]
 * }>}
 */
export async function syncUserCompanyAccessFromCarerix(userProfileId, crUserId) {
  if (!userProfileId || !crUserId) {
    return { synced: 0, unknown: [], functionGroups: [] };
  }

  // Carerix's qualifier engine for CRUser / CRUserCompany indexes `userID`
  // (integer), not `_id`. Using `_id == "42"` returns zero rows — verified
  // against a live Bergur login that wrote no user_company_access rows.
  const crUserIdNum = Number(crUserId);
  if (!Number.isFinite(crUserIdNum)) {
    logger.warn('syncUserCompanyAccessFromCarerix: non-numeric carerix user id — skipping', {
      userProfileId, crUserId,
    });
    return { synced: 0, unknown: [], functionGroups: [] };
  }

  const [userResp, linksResp, registry] = await Promise.all([
    queryGraphQL(`
      query CRUser($qualifier: String) {
        crUserPage(qualifier: $qualifier, pageable: { page: 0, size: 1 }) {
          items { _id userID additionalInfo }
        }
      }
    `, { qualifier: `userID == ${crUserIdNum}` }),
    queryGraphQL(`
      query UserCompanies($qualifier: String, $pageable: Pageable) {
        crUserCompanyPage(qualifier: $qualifier, pageable: $pageable) {
          totalElements
          items { _id toCompany { _id companyID } }
        }
      }
    `, {
      qualifier: `toUser.userID == ${crUserIdNum}`,
      pageable:  { page: 0, size: 100 },
    }),
    getCarerixCheckboxRegistry(),
  ]);

  const additionalInfo = userResp?.data?.crUserPage?.items?.[0]?.additionalInfo || {};
  const functionGroups = [];
  for (const [key, value] of Object.entries(additionalInfo)) {
    // additionalInfo keys sometimes arrive prefixed with an underscore
    const rawKey = key.startsWith('_') ? key.slice(1) : key;
    const code = registry[rawKey];
    if (!code) continue;
    if (String(value).trim() !== '1') continue;
    functionGroups.push(code);
  }

  const links = linksResp?.data?.crUserCompanyPage?.items || [];
  const carerixCompanyIds = Array.from(new Set(
    links
      .map(l => l?.toCompany?.companyID)
      .filter(v => v != null)
      .map(String)
  ));

  logger.info('syncUserCompanyAccessFromCarerix: carerix state', {
    userProfileId,
    crUserId:              crUserIdNum,
    registryEntries:       Object.keys(registry).length,
    additionalInfoKeys:    Object.keys(additionalInfo).length,
    decodedFunctionGroups: functionGroups,
    carerixCompanyIds,
  });

  if (carerixCompanyIds.length === 0) {
    logger.warn('syncUserCompanyAccessFromCarerix: no Carerix company links', {
      userProfileId, crUserId: crUserIdNum,
    });
    return { synced: 0, unknown: [], functionGroups };
  }

  const { data: companies } = await adminSupabase
    .from('companies')
    .select('id, carerix_company_id')
    .in('carerix_company_id', carerixCompanyIds);

  const byCarerixId = new Map((companies || []).map(c => [String(c.carerix_company_id), c.id]));
  const resolved = [];
  const unknown  = [];
  for (const cid of carerixCompanyIds) {
    const uuid = byCarerixId.get(cid);
    if (uuid) resolved.push(uuid);
    else unknown.push(cid);
  }
  if (unknown.length) {
    logger.warn('syncUserCompanyAccessFromCarerix: Carerix companies not yet imported — skipping', {
      userProfileId, crUserId: crUserIdNum, unknown,
    });
  }

  logger.info('syncUserCompanyAccessFromCarerix: resolved platform companies', {
    userProfileId,
    crUserId: crUserIdNum,
    resolved,
    stored:   resolved.length,
  });

  const fgPayload = functionGroups.length ? functionGroups : null;
  const rows = resolved.map(companyId => ({
    user_profile_id: userProfileId,
    company_id:      companyId,
    function_groups: fgPayload,
  }));

  if (rows.length) {
    const { error: upsertErr } = await adminSupabase
      .from('user_company_access')
      .upsert(rows, { onConflict: 'user_profile_id,company_id' });
    if (upsertErr) throw new Error(`user_company_access upsert: ${upsertErr.message}`);
  }

  // User-scoped orphan cleanup: remove rows for THIS user that are no longer
  // in the fresh company set. Never deletes rows for other users, so a bad
  // Carerix response can at worst strip the logging user's own access.
  const { data: existingRows } = await adminSupabase
    .from('user_company_access')
    .select('company_id')
    .eq('user_profile_id', userProfileId);

  const resolvedSet = new Set(resolved);
  const stale = (existingRows || [])
    .map(r => r.company_id)
    .filter(id => !resolvedSet.has(id));

  if (stale.length) {
    const { error: delErr } = await adminSupabase
      .from('user_company_access')
      .delete()
      .eq('user_profile_id', userProfileId)
      .in('company_id', stale);
    if (delErr) logger.warn('user_company_access orphan cleanup failed', { error: delErr.message, userProfileId });
  }

  return { synced: rows.length, unknown, functionGroups };
}

/**
 * Does a placement's contract overlap with a given period?
 *
 * A placement is "active in period" if:
 *   • it has a non-null start_date ≤ period.end_date       (known start, in time)
 *   AND
 *   • its end_date is null, OR ≥ period.start_date          (not ended yet)
 *
 * A null start_date is treated as "not importable / not active" — matching the
 * product rule: every placement must have a known start date in Carerix.
 *
 * @param placement - any object with `start_date` and `end_date` fields
 *                    (strings in 'YYYY-MM-DD' format)
 * @param period    - any object with `start_date` and `end_date` fields
 */
export function isPlacementActiveInPeriod(placement, period) {
  if (!period?.start_date || !period?.end_date) return true;
  const s = placement?.start_date || null;
  const e = placement?.end_date || null;
  if (!s) return false;
  if (s > period.end_date) return false;
  if (e && e < period.start_date) return false;
  return true;
}
