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
  let existing = null;

  // Look up by carerix_user_id first (most specific)
  if (identity.carerixUserId) {
    const { data } = await adminSupabase
      .from('user_profiles')
      .select('id')
      .eq('carerix_user_id', identity.carerixUserId)
      .maybeSingle();
    existing = data;
  }

  // Fallback: look up by email case-insensitively (handles case where carerixUserId was empty on first login)
  if (!existing && identity.email) {
    const { data } = await adminSupabase
      .from('user_profiles')
      .select('id')
      .ilike('email', identity.email.trim())
      .maybeSingle();
    existing = data;
  }

  let supabaseUserId;

  if (existing) {
    supabaseUserId = existing.id;
    // Update non-role fields — don't overwrite manually assigned roles
    // Also populate carerix_user_id if it was missing (fixes future lookups)
    await adminSupabase.from('user_profiles').update({
      display_name:           identity.fullName,
      email:                  identity.email,
      carerix_user_id:        identity.carerixUserId || undefined,
      carerix_company_id:     identity.carerixCompanyId,
      carerix_last_synced_at: new Date().toISOString(),
    }).eq('id', supabaseUserId);
  } else {
    const { data: newUser, error } = await adminSupabase.auth.admin.createUser({
      email:         identity.email,
      email_confirm: true,
      user_metadata: { full_name: identity.fullName, carerix_user_id: identity.carerixUserId, platform_role: identity.platformRole },
    });

    if (error?.message?.includes('already been registered')) {
      // User exists in auth but not in user_profiles — find and link them
      // listUsers is paginated; loop to find the user across all pages
      let authUser = null;
      let page = 1;
      while (!authUser) {
        const { data: authUsers } = await adminSupabase.auth.admin.listUsers({ page, perPage: 1000 });
        authUser = authUsers?.users?.find(u => u.email === identity.email) || null;
        if (!authUser && (!authUsers?.users?.length || authUsers.users.length < 1000)) break;
        page++;
      }
      if (!authUser) throw new Error(`User exists in auth but could not be located: ${identity.email}`);
      supabaseUserId = authUser.id;
    } else if (error) {
      throw new Error(`Failed to create Supabase user: ${error.message}`);
    } else {
      supabaseUserId = newUser.user.id;
    }

    const { error: upsertErr } = await adminSupabase.from('user_profiles').upsert({
      id:                     supabaseUserId,
      auth_source:            'carerix',
      role:                   identity.platformRole,
      display_name:           identity.fullName,
      email:                  identity.email,
      carerix_user_id:        identity.carerixUserId || '',
      carerix_company_id:     identity.carerixCompanyId,
      carerix_contact_id:     identity.carerixContactId,
      carerix_last_synced_at: new Date().toISOString(),
      is_active:              true,
    }, { onConflict: 'id' });
    if (upsertErr) throw new Error(`Failed to create user profile: ${upsertErr.message}`);
  }

  // createSession was removed in Supabase JS v2.
  // Use generateLink to get a magic link, then exchange token_hash for a session.
  const { data: linkData, error: linkErr } = await adminSupabase.auth.admin.generateLink({
    type:  'magiclink',
    email: identity.email,
  });
  if (linkErr) throw new Error(`Failed to generate session link: ${linkErr.message}`);

  // Use token_hash (not the URL token) — this is the correct v2 approach
  const tokenHash = linkData.properties?.hashed_token;
  if (!tokenHash) throw new Error('No hashed_token in generateLink response');

  const { data: otpData, error: otpErr } = await adminSupabase.auth.verifyOtp({
    token_hash: tokenHash,
    type: 'email',
  });
  if (otpErr) throw new Error(`Session creation failed: ${otpErr.message}`);

  return {
    accessToken:  otpData.session.access_token,
    refreshToken: otpData.session.refresh_token,
    expiresAt:    otpData.session.expires_at,
    userId:       supabaseUserId,
    role:         identity.platformRole,
  };
}
