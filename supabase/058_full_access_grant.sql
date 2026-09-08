-- Temporary owner-parity grant (2026-09-08): Joe wants Erika to have "the
-- same access as me with all the features I have including AI until I
-- give further notice." Deliberately NOT done by setting her role to
-- 'owner' -- several places in the app assume exactly one owner (e.g.
-- runGuidelineCheck routes underwriting-review alerts to
-- state.users.filter(role==="owner")[0], and the "Assign to" dropdown
-- labels every owner-role row "(You)"), so a second owner-role row would
-- misroute alerts and mislabel the UI. A dedicated boolean is a clean,
-- single-flag toggle Joe can revoke later without touching her real role.
alter table public.users add column if not exists full_access boolean not null default false;

update public.users set full_access = true where id = 'proc-erika';

-- Extend both places the frontend learns a user's fields -- login (used
-- at sign-in) and list_users (used to hydrate the roster) -- so fullAccess
-- actually reaches the client. Copied forward from 035_portal_prefs.sql,
-- the last redefinition of both.
create or replace function public.login(p_username text, p_pin text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  u public.users;
begin
  select * into u from public.users
    where lower(username) = lower(p_username) and pin = p_pin
    limit 1;
  if u.id is null then
    return null;
  end if;
  return json_build_object(
    'id', u.id, 'name', u.name, 'role', u.role, 'title', u.title,
    'phone', u.phone, 'email', u.email, 'username', u.username,
    'onboarded', u.onboarded, 'emailSignature', u.email_signature, 'textSignoff', u.text_signoff,
    'quoPhoneNumber', u.quo_phone_number, 'photoUrl', u.photo_url,
    'originationSplit', coalesce(u.origination_split, 0.5), 'speaksSpanish', coalesce(u.speaks_spanish, false),
    'portalPrefs', coalesce(u.portal_prefs, '{}'::jsonb),
    'fullAccess', coalesce(u.full_access, false)
  );
end;
$$;
grant execute on function public.login(text, text) to anon;

create or replace function public.list_users()
returns setof json
language sql
security definer
set search_path = public
as $$
  select json_build_object(
    'id', id, 'name', name, 'role', role, 'title', title,
    'phone', phone, 'email', email, 'username', username,
    'quoPhoneNumber', quo_phone_number, 'photoUrl', photo_url,
    'originationSplit', coalesce(origination_split, 0.5), 'speaksSpanish', coalesce(speaks_spanish, false),
    'portalPrefs', coalesce(portal_prefs, '{}'::jsonb),
    'fullAccess', coalesce(full_access, false)
  ) from public.users;
$$;
grant execute on function public.list_users() to anon;

-- Database-level parity: current_app_user() only returns id/role, so give
-- full_access users the same select/update reach as owner directly in the
-- leads RLS policies from 046_staff_auth_and_lead_rls.sql.
drop policy if exists "staff select scoped" on public.leads;
create policy "staff select scoped" on public.leads for select to authenticated using (
  exists (
    select 1 from public.current_app_user() u
    join public.users pu on pu.id = u.app_id
    where u.app_role = 'owner'
       or pu.full_access
       or u.app_id = leads.assigned_to
       or (u.app_role = 'processor' and leads.stage in ('processing','underwriting','ctc','closed'))
  )
);
drop policy if exists "staff update scoped" on public.leads;
create policy "staff update scoped" on public.leads for update to authenticated using (
  exists (
    select 1 from public.current_app_user() u
    join public.users pu on pu.id = u.app_id
    where u.app_role = 'owner'
       or pu.full_access
       or u.app_id = leads.assigned_to
       or (u.app_role = 'processor' and leads.stage in ('processing','underwriting','ctc','closed'))
  )
);
