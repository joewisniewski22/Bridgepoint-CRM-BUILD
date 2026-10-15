-- Silver Hill live pricing (2026-10-14): every portal price creates a Deal Scenario record in Joe's Silver Hill account, so results are cached 24h
-- (same scenario = no new record) and the pricer caps fresh prices per hour. Service-role only (RLS on, no policies).
create table if not exists public.silverhill_quote_cache (
  key text primary key,
  result jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.silverhill_quote_cache enable row level security;
