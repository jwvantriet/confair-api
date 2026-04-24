-- Sync a user's user_company_access rows from a fresh set of Carerix data.
--
-- SECURITY DEFINER lets this run with the function owner's privileges,
-- bypassing RLS regardless of which key (anon / service_role) the calling
-- client uses. Same trick used by `upsert_user_profile`.
--
-- Inputs:
--   p_user_profile_id      — the auth user id
--   p_carerix_company_ids  — Carerix companyIDs (text[]) the user is linked to
--   p_function_groups      — exportCodes the user has checked (text[]).
--                             Empty array = "all groups allowed" (stored NULL).
--
-- Behaviour:
--   1. Resolves each Carerix companyID to a platform UUID via companies.
--   2. Upserts one user_company_access row per resolved company with the
--      same function_groups payload.
--   3. Deletes rows for THIS user only that are no longer in the fresh set
--      (user-scoped orphan cleanup).
--   4. Returns a JSON summary: { synced, unknown, resolved }.

create or replace function public.sync_user_company_access(
  p_user_profile_id      uuid,
  p_carerix_company_ids  text[],
  p_function_groups      text[]
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_unknown   text[] := '{}';
  v_resolved  uuid[] := '{}';
  v_cid       text;
  v_company   uuid;
  v_fg        text[];
  v_synced    int    := 0;
begin
  if array_length(p_function_groups, 1) is null then
    v_fg := null;
  else
    v_fg := p_function_groups;
  end if;

  if p_carerix_company_ids is not null then
    foreach v_cid in array p_carerix_company_ids loop
      select id into v_company
      from public.companies
      where carerix_company_id = v_cid
      limit 1;

      if v_company is null then
        v_unknown := array_append(v_unknown, v_cid);
      else
        v_resolved := array_append(v_resolved, v_company);

        insert into public.user_company_access (user_profile_id, company_id, function_groups)
        values (p_user_profile_id, v_company, v_fg)
        on conflict (user_profile_id, company_id) do update
          set function_groups = excluded.function_groups;

        v_synced := v_synced + 1;
      end if;
    end loop;
  end if;

  delete from public.user_company_access
  where user_profile_id = p_user_profile_id
    and (v_resolved = '{}' or not (company_id = any(v_resolved)));

  return json_build_object(
    'synced',   v_synced,
    'unknown',  v_unknown,
    'resolved', v_resolved
  );
end;
$$;

grant execute on function public.sync_user_company_access(uuid, text[], text[])
  to service_role, authenticated, anon;
