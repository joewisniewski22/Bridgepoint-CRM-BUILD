-- "Export to Lender" sessions (Joe, Erika, Fiore). The CRM creates one when a
-- staff member clicks Export to Lender; the Bridgepoint Chrome extension trades
-- the one-time token for the lender package (loan data + document links) and
-- reports back what it filled/uploaded. Tokens expire after 30 minutes.
-- Service role only: RLS on with no policies.
create table if not exists public.lender_exports (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  lead_id text not null references public.leads(id) on delete cascade,
  lender text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 minutes',
  fetched_at timestamptz,
  log jsonb not null default '[]'::jsonb
);
create index if not exists lender_exports_lead_idx on public.lender_exports(lead_id);
alter table public.lender_exports enable row level security;
