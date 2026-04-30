/**
 * Supabase clients
 *
 * adminSupabase  — service role key, bypasses RLS. Server-side only.
 *                  NEVER call any auth method on this client (signIn,
 *                  verifyOtp, signOut, etc.) — those mutate the client's
 *                  in-memory session and from then on every .from()/.rpc()
 *                  call will use the user's JWT instead of the service
 *                  role key (silently breaking RLS bypass).
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
 * generateLink runs as service-role on adminSupabase (admin call, no
 * session side-effect).
 *
 * verifyOtp, however, **establishes a user session on the client it's
 * called on**. We must NEVER call it on `adminSupabase` — that would set
 * the user's JWT as the auth context for every subsequent admin operation
 * across the entire process, silently breaking RLS bypass.
 *
 * We use a one-shot client purely for verifyOtp. The client falls out of
 * scope and is GC'd after the function returns; the session it created
 * remains valid because we DO NOT call signOut on it. (Counter-intuitively,
 * `auth.signOut({ scope: 'local' })` in supabase-js calls /auth/v1/logout
 * on the server and invalidates the session we just minted — exactly the
 * tokens the user is about to use. Don't do that.)
 */
export async function issueSupabaseSession({ email, userId, role }) {
  const { data: linkData, error: linkErr } = await adminSupabase.auth.admin.generateLink({
    type:  'magiclink',
    email,
  });
  if (linkErr) throw new Error(`Failed to generate session link: ${linkErr.message}`);

  const tokenHash = linkData.properties?.hashed_token;
  if (!tokenHash) throw new Error('No hashed_token in generateLink response');

  const oneShot = createClient(
    config.supabase.url,
    config.supabase.serviceRoleKey,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const { data: otpData, error: otpErr } = await oneShot.auth.verifyOtp({
    token_hash: tokenHash,
    type: 'email',
  });
  if (otpErr) throw new Error(`Session creation failed: ${otpErr.message}`);

  // Intentionally NOT calling oneShot.auth.signOut(): that endpoint
  // invalidates the access_token we're about to return to the user.

  return {
    accessToken:  otpData.session.access_token,
    refreshToken: otpData.session.refresh_token,
    expiresAt:    otpData.session.expires_at,
    userId,
    role,
  };
}

/**
 * Convenience: run both steps. Used by code paths that don't gate on MFA.
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
