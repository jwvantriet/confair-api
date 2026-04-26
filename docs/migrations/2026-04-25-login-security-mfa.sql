-- 2026-04-25: Login security hardening + MFA columns
--
-- 1. user_profiles gains MFA columns (TOTP secret + recovery codes)
-- 2. login_attempts table backs the per-username lockout
--
-- Apply via: supabase db push (or paste into the SQL editor)

-- ── MFA columns on user_profiles ─────────────────────────────────────────
alter table public.user_profiles
  add column if not exists mfa_secret         text,
  add column if not exists mfa_pending_secret text,
  add column if not exists mfa_enrolled_at    timestamptz,
  add column if not exists mfa_recovery_codes text[] default '{}'::text[];

comment on column public.user_profiles.mfa_secret
  is 'Base32 TOTP shared secret. Set after a successful enrollment verification. Treat as sensitive.';
comment on column public.user_profiles.mfa_pending_secret
  is 'Staged TOTP secret while the user is verifying their authenticator app. Cleared on activation or cancel.';
comment on column public.user_profiles.mfa_enrolled_at
  is 'Timestamp the user first verified TOTP. Non-null = MFA active for this user.';
comment on column public.user_profiles.mfa_recovery_codes
  is 'SHA-256 hashes of single-use recovery codes. Codes themselves are shown to the user only once.';

-- ── login_attempts table ─────────────────────────────────────────────────
create table if not exists public.login_attempts (
  id           uuid primary key default gen_random_uuid(),
  username     text not null,
  succeeded    boolean not null default false,
  ip_address   text,
  user_agent   text,
  attempted_at timestamptz not null default now()
);

-- Sliding-window lookups by username always filter on attempted_at desc.
create index if not exists login_attempts_username_idx
  on public.login_attempts (username, attempted_at desc);

create index if not exists login_attempts_attempted_at_idx
  on public.login_attempts (attempted_at desc);

-- RLS: only service-role writes / reads. The API uses adminSupabase, so this
-- is mostly belt-and-braces — we don't want a leaked anon key to expose
-- timing data about login attempts.
alter table public.login_attempts enable row level security;

drop policy if exists login_attempts_service_only on public.login_attempts;
create policy login_attempts_service_only on public.login_attempts
  for all
  to service_role
  using (true)
  with check (true);

-- ── Cleanup function ─────────────────────────────────────────────────────
-- Schedule via pg_cron (or call from a periodic job) to keep the table small.
create or replace function public.cleanup_login_attempts()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.login_attempts where attempted_at < now() - interval '30 days';
$$;

grant execute on function public.cleanup_login_attempts() to service_role;
