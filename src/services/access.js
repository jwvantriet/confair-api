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
 *   []    → authenticated non-agency with zero companies linked, OR
 *           user's access has not been successfully synced from Carerix
 *           ('never' / 'failed') — fail-closed default
 *   [...] → concrete list of company uuids
 */
import { adminSupabase } from './supabase.js';
import {
  queryGraphQL,
  getCarerixCheckboxRegistry,
  fetchPlacementIdentityByCrUserId,
} from './carerix.js';
import { logger } from '../utils/logger.js';

/**
 * @returns {Promise<null | string[]>}
 *
 * Watertight: a user whose access has never been successfully synced from
 * Carerix (status='never') or who is currently in the failed-first-sync
 * state ('failed') gets zero access. Stale and synced states use the rows
 * in user_company_access verbatim — last-known-good for stale, fresh for
 * synced.
 */
export async function companyIdsForUser(user) {
  if (!user) return [];
  if (user.role?.startsWith('agency_')) return null;

  if (user.access_sync_status === 'never' || user.access_sync_status === 'failed') {
    return [];
  }

  const { data: access } = await adminSupabase
    .from('user_company_access')
    .select('company_id')
    .eq('user_profile_id', user.id);
  return (access || []).map(r => r.company_id);
}

/**
 * Returns the full access rule set for a non-agency user:
 *   [{ company_id, function_groups }]
 *
 * function_groups semantics:
 *   null  → "all groups allowed" (admin override only — Carerix sync never writes this)
 *   []    → "no groups" (explicit deny)
 *   [...] → specific groups
 *
 * For agency roles returns null (= no restriction).
 *
 * Watertight: same status gating as companyIdsForUser. The previous
 * "synthesise an unrestricted rule from legacy carerix_company_id" fallback
 * has been removed — that path silently granted all-groups to any user
 * whose user_company_access table was empty.
 *
 * @returns {Promise<null | Array<{company_id: string, function_groups: string[] | null}>>}
 */
export async function accessRulesForUser(user) {
  if (!user) return [];
  if (user.role?.startsWith('agency_')) return null;

  if (user.access_sync_status === 'never' || user.access_sync_status === 'failed') {
    return [];
  }

  const { data: rows } = await adminSupabase
    .from('user_company_access')
    .select('company_id, function_groups')
    .eq('user_profile_id', user.id);
  return rows || [];
}

/**
 * Filters a list of placements down to only those that match the user's
 * per-company function_groups scope. Expects each placement to have
 * `company_id` and `carerix_function_group_id` fields. The rule's
 * function_groups array holds function_group IDs (as strings) — these match
 * the Carerix CRDataNode exportCode decoded at login.
 *
 * If rules is null (agency), returns the list unchanged.
 * If a placement's company has function_groups=null in rules, all groups pass
 *   (admin "grant all" override).
 * If function_groups is an empty array, NO groups pass for that company.
 * If function_groups is a non-empty array, only matching group IDs pass.
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
    if (groups === null || groups === undefined) return true;     // admin grant-all
    if (!Array.isArray(groups) || groups.length === 0) return false; // explicit deny
    return groups.includes(String(p.carerix_function_group_id));
  });
}

/**
 * Sync a user's `user_company_access` rows from their live Carerix state.
 *
 * Watertight semantics:
 *   - If we cannot reach Carerix (registry null, GraphQL error), abort
 *     without touching DB. Return status so the login flow can decide
 *     to block (first-ever login) or degrade gracefully (subsequent login
 *     with a prior successful sync).
 *   - An empty function_groups array means "explicit zero access", NOT
 *     "all groups granted". The v2 RPC stores it verbatim.
 *
 * Runs three queries in parallel:
 *   1. crUserPage        — for CRUser.additionalInfo (checkbox values)
 *   2. crUserCompanyPage — for linked CRCompanies
 *   3. getCarerixCheckboxRegistry — dataNodeID → exportCode map
 *
 * Returns a status union — callers MUST inspect `status`:
 *   { status: 'synced',    synced, unknown, functionGroups }   happy path
 *   { status: 'unchanged', reason, functionGroups }            no Carerix links yet
 *   { status: 'aborted',   reason, error? }                    transient failure
 */
export async function syncUserCompanyAccessFromCarerix(userProfileId, crUserId) {
  if (!userProfileId || !crUserId) {
    return { status: 'aborted', reason: 'missing_inputs' };
  }

  // Carerix's qualifier engine for CRUser / CRUserCompany indexes `userID`
  // (integer), not `_id`. Using `_id == "42"` returns zero rows — verified
  // against a live Bergur login that wrote no user_company_access rows.
  const crUserIdNum = Number(crUserId);
  if (!Number.isFinite(crUserIdNum)) {
    logger.warn('syncUserCompanyAccessFromCarerix: non-numeric carerix user id — skipping', {
      userProfileId, crUserId,
    });
    return { status: 'aborted', reason: 'non_numeric_carerix_user_id' };
  }

  let userResp, linksResp, registry;
  try {
    [userResp, linksResp, registry] = await Promise.all([
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
  } catch (err) {
    return { status: 'aborted', reason: 'carerix_unreachable', error: err.message };
  }

  // Registry null = Carerix unreachable. Without the registry we cannot decode
  // additionalInfo, so we must NOT write — a written-but-empty function_groups
  // would either deny all access (if Carerix is the source of truth) or
  // silently widen it under the legacy v1 RPC. Either way, fail-closed and
  // let the caller decide.
  if (registry === null) {
    return { status: 'aborted', reason: 'registry_unavailable' };
  }

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
    return {
      status: 'unchanged',
      reason: 'no_carerix_company_links',
      functionGroups,
    };
  }

  // Delegate the platform-side write to the v2 SECURITY DEFINER RPC. Direct
  // adminSupabase writes can fail under RLS if the env-var key is wrong;
  // SECURITY DEFINER runs with the function owner's privileges and bypasses
  // RLS entirely. Same trick used by `upsert_user_profile`.
  const { data: rpcResult, error: rpcErr } = await adminSupabase.rpc(
    'sync_user_company_access_v2',
    {
      p_user_profile_id:     userProfileId,
      p_carerix_company_ids: carerixCompanyIds,
      p_function_groups:     functionGroups,
      p_grant_all:           false,
    },
  );
  if (rpcErr) {
    return { status: 'aborted', reason: 'rpc_failure', error: rpcErr.message };
  }

  logger.info('syncUserCompanyAccessFromCarerix: rpc result', {
    userProfileId,
    crUserId: crUserIdNum,
    rpcResult,
  });

  return {
    status:         'synced',
    synced:         rpcResult?.synced   ?? 0,
    unknown:        rpcResult?.unknown  ?? [],
    functionGroups,
  };
}

/**
 * Sync a placement's identity (carerix_employee_id + function group level 1)
 * from Carerix at login time. Looks up the employee by CRUser userID — the
 * legacy XML login response doesn't always carry the toEmployee link, so
 * the GraphQL CRUser→toEmployee path is the reliable one.
 *
 * Idempotent. Same status union as syncUserCompanyAccessFromCarerix.
 */
export async function syncPlacementIdentityFromCarerix(userProfileId, crUserId) {
  if (!userProfileId || !crUserId) {
    return { status: 'aborted', reason: 'missing_inputs' };
  }
  const fg = await fetchPlacementIdentityByCrUserId(crUserId);
  if (!fg) {
    return { status: 'aborted', reason: 'employee_lookup_failed' };
  }
  const { data, error } = await adminSupabase.rpc('sync_placement_identity_carerix', {
    p_user_profile_id:     userProfileId,
    p_carerix_employee_id: fg.employeeID,
    p_fg_level1_id:        fg.fgLevel1Id,
    p_fg_level1_code:      fg.fgLevel1Code,
    p_fg_level1_name:      fg.fgLevel1Name,
  });
  if (error) {
    return { status: 'aborted', reason: 'rpc_failure', error: error.message };
  }
  logger.info('syncPlacementIdentityFromCarerix: rpc result', { userProfileId, crUserId, data });
  return {
    status:       'synced',
    employeeID:   fg.employeeID,
    fgLevel1Id:   fg.fgLevel1Id,
    fgLevel1Code: fg.fgLevel1Code,
    fgLevel1Name: fg.fgLevel1Name,
  };
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
