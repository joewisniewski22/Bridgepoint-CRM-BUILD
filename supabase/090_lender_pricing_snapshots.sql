-- Daily pricing snapshots for researched lender models (A&D Mortgage first).
-- Written by the "ad-rate-refresh" scheduled task (Claude app, Joe's logged-in
-- A&D session); read by check-live-rates so quotes use the current rate sheet.
-- Service role only: RLS on with no policies.
create table if not exists public.lender_pricing_snapshots (
  lender text primary key,
  data jsonb not null,
  sheet_as_of text,
  captured_at timestamptz not null default now(),
  check_passed int,
  check_total int
);
alter table public.lender_pricing_snapshots enable row level security;
