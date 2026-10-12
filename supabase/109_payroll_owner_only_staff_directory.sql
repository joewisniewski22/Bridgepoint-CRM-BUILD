-- 109 (10/12/2026, Joe): payroll is visible to the owner only, and the staff directory (phone, email, username)
-- is visible only to signed-in staff -- not to anonymous visitors and not to future broker logins.
-- The borrower page gets its own loan officer's contact details from portal-api, not from this list.

-- payroll: owner only (was: any signed-in staff member could read every payroll row)
drop policy if exists "authenticated full access" on public.payroll_entries;
create policy "owner only" on public.payroll_entries for all to authenticated
  using (exists (select 1 from public.current_app_user() u where u.app_role = 'owner'))
  with check (exists (select 1 from public.current_app_user() u where u.app_role = 'owner'));

-- staff directory: full details for signed-in staff, names only for everyone else
create or replace function public.list_users() returns setof json language sql security definer set search_path to 'public' as $f$
  select case
    when exists (select 1 from public.users s where s.auth_id = auth.uid()) then
      json_build_object(
        'id', id, 'name', name, 'role', role, 'title', title, 'phone', phone, 'email', email, 'username', username,
        'nmls', nmls_number, 'fullAccess', coalesce(full_access, false), 'portalPrefs', coalesce(portal_prefs, '{}'::jsonb),
        'outToday', coalesce(out_date = (now() at time zone 'America/New_York')::date, false),
        'speaksSpanish', coalesce(speaks_spanish, false))
    else
      json_build_object('id', id, 'name', name, 'role', role, 'title', title, 'speaksSpanish', coalesce(speaks_spanish, false))
  end
  from public.users;
$f$;
grant execute on function public.list_users() to anon, authenticated, service_role;
