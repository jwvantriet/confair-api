/**
 * Supabase clients
 *
 * adminSupabase  — service role key, bypasses RLS. Server-side only.
 * userSupabase() — per-request client scoped to a user JWT. Respects RLS.
 */

import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';
import { ApiError } from '../middleware/errorHandler.js';

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
 * Step 1 of login: ensure a user_profiles row exists for the Carerix
 * identity and refuse outright if the account is deactivated.
 *
 * Splitting profile-upsert from session-issuance lets the auth route park
 * a freshly-authenticated user at the MFA challenge before any Supabase
 * tokens are minted. No tokens leave the server until MFA passes (or is
 * not required).
 *
 * @returns {Promise<{ userId: string }>}
 */
export async function provisionCarerixUser(identity) {
  let existing = null;

  if (identity.carerixUserId) {
    const { data } = await adminSupabase
      .from('user_profiles')
      .select('id, is_active')
      .eq('carerix_user_id', identity.carerixUserId)
      .maybeSingle();
    existing = data;
  }
  if (!existing && identity.email) {
    const { data } = await adminSupabase
      .from('user_profiles')
      .select('id, is_active')
      .ilike('email', identity.email.trim())
      .maybeSingle();
    existing = data;
  }

  // Refuse early if a profile exists but has been deactivated. New users
  // (no profile yet) are provisioned with is_active=true below.
  if (existing && existing.is_active === false) {
    throw new ApiError('Account is inactive', 403);
  }

  let supabaseUserId;

  if (existing) {
    supabaseUserId = existing.id;
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

    const { error: upsertErr } = await adminSupabase.rpc('upsert_user_profile', {
      p_id:                 supabaseUserId,
      p_auth_source:        'carerix',
      p_role:               identity.platformRole,
      p_display_name:       identity.fullName,
      p_email:              identity.email,
      p_carerix_user_id:    identity.carerixUserId || null,
      p_carerix_company_id: identity.carerixCompanyId || null,
      p_carerix_contact_id: identity.carerixContactId || null,
      p_is_active:          true,
    });
    if (upsertErr) throw new Error(`Failed to create user profile: ${upsertErr.message}`);
  }

  return { userId: supabaseUserId };
}

/**
 * Step 2 of login (post-MFA, or no-MFA): mint a Supabase session.
 *
 * Uses generateLink → verifyOtp because Supabase v2 removed createSession.
 */
export async function issueSupabaseSession({ email, userId, role }) {
  const { data: linkData, error: linkErr } = await adminSupabase.auth.admin.generateLink({
    type:  'magiclink',
    email,
  });
  if (linkErr) throw new Error(`Failed to generate session link: ${linkErr.message}`);

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
    userId,
    role,
  };
}

/**
 * Convenience: run both steps. Used by code paths that don't gate on MFA
 * (e.g. legacy callers or admin-impersonation flows). New code should call
 * the two halves explicitly so MFA can be inserted between them.
 */
export async function provisionCarerixSession(identity) {
  const { userId } = await provisionCarerixUser(identity);
  const session    = await issueSupabaseSession({
    email:  identity.email,
    userId,
    role:   identity.platformRole,
  });
  return session;
}
