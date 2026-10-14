-- 116: Growth tracker (Joe 2026-10-14: "track everything you need to make sure we hit that goal"). Goal lives in growth_goals
-- ($6M/month funded for 3 straight months, then $10M/month). This adds a daily ad-spend ledger and a daily snapshot so trends and
-- cost-per-funded-loan can be computed against real CRM outcomes. Owner + Fiore only.

create table if not exists public.ad_spend_daily (
  day date not null,
  campaign_id text not null,
  campaign_name text,
  spend numeric not null default 0,
  impressions integer not null default 0,
  clicks integer not null default 0,
  leads integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (day, campaign_id)
);
create table if not exists public.growth_snapshots (
  day date primary key,
  data jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.ad_spend_daily enable row level security;
alter table public.growth_snapshots enable row level security;
drop policy if exists growth_inner_all on public.ad_spend_daily;
drop policy if exists growth_inner_all on public.growth_snapshots;
create policy growth_inner_all on public.ad_spend_daily for all to authenticated
  using (public.is_staff() and exists (select 1 from public.current_app_user() u where u.app_id in ('owner','lo-fiore')))
  with check (public.is_staff() and exists (select 1 from public.current_app_user() u where u.app_id in ('owner','lo-fiore')));
create policy growth_inner_all on public.growth_snapshots for all to authenticated
  using (public.is_staff() and exists (select 1 from public.current_app_user() u where u.app_id in ('owner','lo-fiore')))
  with check (public.is_staff() and exists (select 1 from public.current_app_user() u where u.app_id in ('owner','lo-fiore')));
