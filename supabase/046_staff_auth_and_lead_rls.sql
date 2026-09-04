-- Security hardening pass 2 (2026-09-04): real per-staff sessions + row-level
-- lead visibility. Pass 1 (045) could only remove DELETE, because every
-- client -- owner, every LO, every processor, AND every anonymous borrower
-- -- shared the exact same public anon key, so Postgres had no way to tell
-- them apart. This migration is the other half: staff now get a REAL,
-- Supabase-issued session (via a new auth_id linking public.users to a real
-- auth.users record), so RLS can finally check who's actually asking.
--
-- Scope: leads table only, and only SELECT/UPDATE (visibility + editing).
-- INSERT stays open to any authenticated staff member (matches today's
-- behavior -- any LO/owner can add a new lead). The public/anonymous
-- borrower-portal flow (?apply=id&t=token) is UNCHANGED -- it still uses
-- the plain anon key with no session, and the existing anon policies from
-- 045 are left in place for it. That means a sophisticated actor who skips
-- sending a staff session and calls the API as plain anon still gets the
-- old broad access -- closing that specific gap requires moving the public
-- application/booking/document flows onto validated RPCs instead of direct
-- table access, which is a separate follow-up, not done here.

alter table public.users add column if not exists auth_id uuid unique;

-- Resolves the CURRENT request's real Supabase Auth identity (auth.uid())
-- back to this app's own user id + role. SECURITY DEFINER so it can read
-- public.users despite that table having zero policies for anyone else --
-- safe because it only ever returns the row matching the caller's own
-- auth.uid(), never anyone else's.
create or replace function public.current_app_user()
returns table(app_id text, app_role text)
language sql
security definer
stable
set search_path = public
as $$
  select id, role from public.users where auth_id = auth.uid();
$$;
grant execute on function public.current_app_user() to authenticated;

create policy "staff select scoped" on public.leads for select to authenticated using (
  exists (
    select 1 from public.current_app_user() u
    where u.app_role = 'owner'
       or u.app_id = leads.assigned_to
       or (u.app_role = 'processor' and leads.stage in ('processing','underwriting','ctc','closed'))
  )
);
create policy "staff insert" on public.leads for insert to authenticated with check (
  exists (select 1 from public.current_app_user())
);
create policy "staff update scoped" on public.leads for update to authenticated using (
  exists (
    select 1 from public.current_app_user() u
    where u.app_role = 'owner'
       or u.app_id = leads.assigned_to
       or (u.app_role = 'processor' and leads.stage in ('processing','underwriting','ctc','closed'))
  )
);
