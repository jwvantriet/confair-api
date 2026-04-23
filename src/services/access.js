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
