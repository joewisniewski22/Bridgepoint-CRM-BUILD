-- Growth goal tracking + real business inputs, read by the AI Assistant's
-- analyze_growth_progress tool so "how are we tracking" always has the
-- real target/timeline/baseline to compare against instead of Joe having
-- to restate it every time.
create table if not exists public.growth_goals (
  id text primary key default 'default',
  current_target_monthly numeric not null default 6000000,
  consecutive_months_required int not null default 3,
  consecutive_months_hit int not null default 0,
  next_target_monthly numeric not null default 10000000,
  goal_start_date date not null default current_date,
  target_deadline_months int not null default 6,
  cix_leads_per_month int not null default 60,
  daily_fb_spend numeric not null default 25,
  notes text,
  updated_at timestamptz not null default now()
);

insert into public.growth_goals (id) values ('default')
on conflict (id) do nothing;

alter table public.growth_goals enable row level security;

drop policy if exists "growth_goals_read" on public.growth_goals;
create policy "growth_goals_read" on public.growth_goals
  for select using (true);

drop policy if exists "growth_goals_write" on public.growth_goals;
create policy "growth_goals_write" on public.growth_goals
  for all using (true) with check (true);
