-- A reusable directory of deal-coordination contacts (title companies,
-- insurance agents, escrow officers, attorneys, appraisers) that aren't
-- specific to any one loan -- Joe's ask (2026-09-25): staff kept retyping
-- the same title company/insurance agent into every new file's Third
-- Parties tab. Separate from referral_partners (043_referral_partners.sql),
-- which tracks people who SEND Bridgepoint business and accumulates a
-- referral track record -- this is just an address book to pick from when
-- staffing a specific loan, with no relationship-tracking of its own.
create table if not exists public.third_party_contacts (
  id text primary key,
  role text not null,
  name text not null,
  company text,
  phone text,
  email text,
  notes text,
  created_at timestamptz not null default now(),
  created_by text
);
alter table public.third_party_contacts enable row level security;
create policy "anon full access" on public.third_party_contacts for all to anon using (true) with check (true);
