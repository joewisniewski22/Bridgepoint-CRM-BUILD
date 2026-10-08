-- Virtual Underwriter results (Joe 2026-10-08): one row per loan file with the last
-- pre-submission check (lender, flags, sign-off). Names the lender, so it lives
-- outside public.leads and only Joe, Fiore and Erika can read or write it:
-- owner, full-access users, Fiore (lo-fiore) and Erika (proc-erika) -- not the demo logins.
create table if not exists public.lead_underwriting (
  lead_id text primary key references public.leads(id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.lead_underwriting enable row level security;
drop policy if exists "staff underwriting" on public.lead_underwriting;
create policy "staff underwriting" on public.lead_underwriting for all to authenticated using (
  exists (select 1 from public.current_app_user() u
          where u.app_role = 'owner' or u.app_full_access or u.app_id in ('lo-fiore', 'proc-erika'))
) with check (
  exists (select 1 from public.current_app_user() u
          where u.app_role = 'owner' or u.app_full_access or u.app_id in ('lo-fiore', 'proc-erika'))
);
grant select, insert, update, delete on public.lead_underwriting to authenticated;
