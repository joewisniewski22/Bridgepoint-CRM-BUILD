-- Fixes a real regression introduced by 058_full_access_grant.sql within
-- minutes of shipping it. That migration added `join public.users pu on
-- pu.id = u.app_id` directly inside the leads RLS policy body -- but a
-- policy's qual runs as the CALLING role (authenticated), not as the
-- security-definer function it references, so that join was itself
-- subject to RLS on public.users. public.users has no permissive select
-- policy for authenticated, so the join returned zero rows and the
-- EXISTS collapsed to false for every branch, not just the new
-- full_access one -- verified live: Erika's own session went from seeing
-- her processing-stage leads to seeing nothing at all.
--
-- Fix: extend current_app_user() itself (already SECURITY DEFINER, so it
-- safely reads public.users bypassing RLS, and only ever returns the
-- caller's own row) to also return full_access, instead of joining to
-- public.users from inside the policy.

-- Policies depend on current_app_user()'s current signature -- drop them
-- first so the function can be dropped and recreated with a new one.
drop policy if exists "staff select scoped" on public.leads;
drop policy if exists "staff update scoped" on public.leads;
drop policy if exists "staff insert" on public.leads;
drop policy if exists "owner delete any lead" on public.leads;

drop function if exists public.current_app_user();
create function public.current_app_user()
returns table(app_id text, app_role text, app_full_access boolean)
language sql
security definer
stable
set search_path = public
as $$
  select id, role, coalesce(full_access, false) from public.users where auth_id = auth.uid();
$$;
grant execute on function public.current_app_user() to authenticated;

create policy "staff insert" on public.leads for insert to authenticated with check (
  exists (select 1 from public.current_app_user())
);
create policy "owner delete any lead" on public.leads for delete to authenticated using (
  exists (
    select 1 from public.current_app_user() u
    where u.app_role = 'owner'
  )
);
create policy "staff select scoped" on public.leads for select to authenticated using (
  exists (
    select 1 from public.current_app_user() u
    where u.app_role = 'owner'
       or u.app_full_access
       or u.app_id = leads.assigned_to
       or (u.app_role = 'processor' and leads.stage in ('processing','underwriting','ctc','closed'))
  )
);
create policy "staff update scoped" on public.leads for update to authenticated using (
  exists (
    select 1 from public.current_app_user() u
    where u.app_role = 'owner'
       or u.app_full_access
       or u.app_id = leads.assigned_to
       or (u.app_role = 'processor' and leads.stage in ('processing','underwriting','ctc','closed'))
  )
);
