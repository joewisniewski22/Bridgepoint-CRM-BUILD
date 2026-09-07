-- Live-tunable engagement settings the AI Assistant can adjust based on
-- real conversion data, instead of hardcoded constants that need a code
-- deploy to change. Singleton row.
create table if not exists public.engagement_config (
  id text primary key default 'default',
  cadence_max int not null default 5,
  messaging_guidance text not null default '',
  last_adjustment_reason text,
  last_adjusted_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into public.engagement_config (id) values ('default')
on conflict (id) do nothing;

alter table public.engagement_config enable row level security;

drop policy if exists "engagement_config_read" on public.engagement_config;
create policy "engagement_config_read" on public.engagement_config
  for select using (true);

drop policy if exists "engagement_config_write" on public.engagement_config;
create policy "engagement_config_write" on public.engagement_config
  for all using (true) with check (true);
