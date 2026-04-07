/**
 * Supabase clients
 *
 * adminSupabase  — service role key, bypasses RLS. Server-side only.
 * userSupabase() — per-request client scoped to a user JWT. Respects RLS.
 */

import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

export const adminSupabase = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

export function userSupabase(accessToken) {
  return createClient(
    config.supabase.url,
    config.supabase.anonKey,
    {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth:   { autoRefreshToken: false, persistSession: false },
    }
  );
}

/**
 * Provisions or updates a Supabase user for a Carerix-authenticated identity.
 *
 * Flow:
 *   1. Check if carerix_user_id already exists in user_profiles
 *   2. If yes  → sync profile fields, issue new session
 *   3. If no   → create auth.users entry + user_profiles row, issue session
 */
export async function provisionCarerixSession(identity) {
  const { data: existing } = await adminSupabase
    .from('user_profiles')
    .select('id')
    .eq('carerix_user_id', identity.carerixUserId)
    .maybeSingle();

  let supabaseUserId;

  if (existing) {
    supabaseUserId = existing.id;
    await adminSupabase.from('user_profiles').update({
      display_name:           identity.fullName,
      email:                  identity.email,
      carerix_company_id:     identity.carerixCompanyId,
      carerix_contact_id:     identity.carerixContactId,
      carerix_last_synced_at: new Date().toISOString(),
      role:                   identity.platformRole,
    }).eq('id', supabaseUserId);
  } else {
    const { data: newUser, error } = await adminSupabase.auth.admin.createUser({
      email:         identity.email,
      email_confirm: true,
      user_metadata: { full_name: identity.fullName, carerix_user_id: identity.carerixUserId, platform_role: identity.platformRole },
    });
    if (error) throw new Error(`Failed to create Supabase user: ${error.message}`);
    supabaseUserId = newUser.user.id;

    await adminSupabase.from('user_profiles').insert({
      id:                     supabaseUserId,
      auth_source:            'carerix',
      role:                   identity.platformRole,
      display_name:           identity.fullName,
      email:                  identity.email,
      carerix_user_id:        identity.carerixUserId,
      carerix_company_id:     identity.carerixCompanyId,
      carerix_contact_id:     identity.carerixContactId,
      carerix_last_synced_at: new Date().toISOString(),
    });
  }

  const { data: session, error: sessionErr } = await adminSupabase.auth.admin.createSession({ userId: supabaseUserId });
  if (sessionErr) throw new Error(`Session creation failed: ${sessionErr.message}`);

  return {
    accessToken:  session.session.access_token,
    refreshToken: session.session.refresh_token,
    expiresAt:    session.session.expires_at,
    userId:       supabaseUserId,
    role:         identity.platformRole,
  };
}
