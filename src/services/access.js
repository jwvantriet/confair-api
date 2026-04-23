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
 * Convenience: resolve the placements a user can see, or null for agency.
 * Returns [] for non-agency users with zero company access.
 */
export async function placementIdsForUser(user) {
  const companyIds = await companyIdsForUser(user);
  if (companyIds === null) return null;
  if (!companyIds.length) return [];
  const { data } = await adminSupabase
    .from('placements').select('id').in('company_id', companyIds);
  return (data || []).map(p => p.id);
}
