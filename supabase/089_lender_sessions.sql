-- Cached login session for live outside-lender pricers (RCN Capital's broker
-- pricing tool), so check-live-rates logs in once instead of on every quote.
-- Service role only: RLS on with no policies.
create table if not exists public.lender_sessions (
  lender text primary key,
  session jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.lender_sessions enable row level security;
