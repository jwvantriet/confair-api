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
 * `company_id` and `carerix_function_group` fields.
 *
 * If rules is null (agency), returns the list unchanged.
 * If a placement's company has function_groups=null in rules, all groups pass.
 * If function_groups is an array, only matching groups pass.
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
    return groups.includes(p.carerix_function_group);
  });
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
