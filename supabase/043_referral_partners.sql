-- Referral partner relationship tracking (realtors, wholesalers, other
-- lenders, attorneys, etc. who send Bridgepoint business). Separate from
-- the per-lead third_parties array (which is deal-coordination contacts,
-- not persistent relationships) -- a partner exists independent of any
-- one loan and accumulates a track record of referrals over time.
create table if not exists public.referral_partners (
  id text primary key,
  name text not null,
  company text,
  role text, -- 'Realtor' | 'Wholesaler' | 'Attorney' | 'Other Lender' | 'Title/Escrow' | 'Other'
  phone text,
  email text,
  notes text,
  created_at timestamptz not null default now(),
  created_by text
);
alter table public.referral_partners enable row level security;
create policy "anon full access" on public.referral_partners for all to anon using (true) with check (true);

alter table public.leads add column if not exists referral_partner_id text references public.referral_partners(id) on delete set null;
