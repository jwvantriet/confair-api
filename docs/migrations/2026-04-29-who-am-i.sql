-- 2026-04-29: who_am_i() diagnostic function
--
-- Purpose: lets the API report which Postgres role its connection is
-- actually operating as, so we can prove whether the service_role key
-- is being recognised by PostgREST.
--
-- Returns JSON with:
--   current_user            — the active role for this query (after JWT-based set role)
--   session_user            — the role used to authenticate (always 'authenticator' for PostgREST)
--   jwt_role                — the 'role' claim from the JWT, or null if missing/invalid
--   jwt_claims              — full JWT claims (for debugging)
--   has_bypassrls           — does the active role have BYPASSRLS?
--
-- Apply via: paste into the Supabase SQL Editor and run.

create or replace function public.who_am_i()
returns json
language sql
stable
security invoker
as $$
  select json_build_object(
    'current_user',  current_user,
    'session_user',  session_user,
    'jwt_role',      current_setting('request.jwt.claim.role', true),
    'jwt_claims',    current_setting('request.jwt.claims', true),
    'has_bypassrls', (select rolbypassrls from pg_roles where rolname = current_user)
  );
$$;

-- Anyone can call it — it only returns metadata about the calling session.
grant execute on function public.who_am_i() to service_role, authenticated, anon;
