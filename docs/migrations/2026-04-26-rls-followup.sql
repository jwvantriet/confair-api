-- 2026-04-26: RLS fix for telemetry tables
--
-- Symptom: every login emits
--   [err] Audit log write failed
-- and the client error logger returns 500 with
--   new row violates row-level security policy for table "client_errors"
--
-- Cause: both tables were created with FORCE ROW LEVEL SECURITY enabled,
-- which makes RLS apply even to service_role. None of the existing policies
-- grant service_role insert, so admin-side writes are denied.
--
-- Fix: turn off force-RLS on these telemetry tables. They are written from
-- adminSupabase (server only) and are not exposed to anon/authenticated
-- clients, so RLS itself is belt-and-braces.

alter table public.audit_log     no force row level security;
alter table public.client_errors no force row level security;

-- Belt-and-braces: ensure service_role can insert. (No-op if a permissive
-- policy already exists.)
drop policy if exists audit_log_service_writes on public.audit_log;
create policy audit_log_service_writes on public.audit_log
  for insert
  to service_role
  with check (true);

drop policy if exists audit_log_service_reads on public.audit_log;
create policy audit_log_service_reads on public.audit_log
  for select
  to service_role
  using (true);

drop policy if exists client_errors_service_writes on public.client_errors;
create policy client_errors_service_writes on public.client_errors
  for insert
  to service_role
  with check (true);

drop policy if exists client_errors_service_reads on public.client_errors;
create policy client_errors_service_reads on public.client_errors
  for select
  to service_role
  using (true);
