-- Bridgepoint Lending Desk — Stage 2: leads, notifications, market rates
-- Run this in the Supabase SQL Editor BEFORE running 004_seed_data.sql.

create table public.leads (
  id text primary key,
  name text,
  email text,
  phone text,
  source text,
  loan_type text,
  stage text,
  status text,
  assigned_to text references public.users(id),
  created_at date,
  entity_type text,
  credit_score int,
  experience_deals int,
  liquidity numeric,
  property_address text,
  property_type text,
  purchase_price numeric,
  arv numeric,
  rehab_budget numeric,
  rent_estimate numeric,
  loan_amount numeric,
  ltv numeric,
  rate numeric,
  term_months int,
  exit_strategy text,
  close_date date,
  next_follow_up date,
  next_follow_up_note text,
  points_charged numeric,
  created_at_ts timestamptz,
  first_attempt_at timestamptz,
  application_sent_at date,
  application_taken_by_phone boolean default false,
  application_taken_at date,
  appraisal_ordered boolean default false,
  appraisal_ordered_at date,
  title_ordered boolean default false,
  title_ordered_at date,
  preapproval_sent_at date,
  termsheet_sent_at date,
  credit_ordered_at date,
  last_contact_at date,
  call_attempts jsonb not null default '[]',
  activity jsonb not null default '[]',
  documents jsonb not null default '[]',
  third_parties jsonb not null default '[]'
);

create table public.notifications (
  id text primary key,
  to_user_id text references public.users(id),
  lead_id text references public.leads(id),
  kind text,
  text text,
  date date,
  read boolean not null default false
);

create table public.market_rates (
  key text primary key,
  label text,
  previous numeric,
  current numeric,
  updated_at date
);

-- RLS is enabled, but kept permissive for the app's public (anon) key while
-- this is a small, trusted internal team in a testing phase. Role-based
-- restrictions (who sees what) are enforced in the app's UI, not the
-- database — anyone with the anon key and API knowledge could technically
-- read/write any row directly. Fine for now; revisit with real per-user
-- Supabase Auth sessions before this holds real client-sensitive data at
-- meaningful scale.
alter table public.leads enable row level security;
alter table public.notifications enable row level security;
alter table public.market_rates enable row level security;

create policy "anon full access" on public.leads for all to anon using (true) with check (true);
create policy "anon full access" on public.notifications for all to anon using (true) with check (true);
create policy "anon full access" on public.market_rates for all to anon using (true) with check (true);

grant select, insert, update, delete on public.leads to anon;
grant select, insert, update, delete on public.notifications to anon;
grant select, insert, update, delete on public.market_rates to anon;
