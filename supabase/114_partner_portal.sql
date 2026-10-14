-- 114: referral partner links + partner portal (Joe 2026-10-14: "a referral partner link where they can share it with new borrowers, however it
-- gets filed to us so we know where it came from ... and a referral partner portal where they can get updates, price their own stuff").
-- Partners never touch the CRM or its tables: everything goes through the partner-api edge function (service role), scoped to their own referrals.

alter table public.referral_partners
  add column if not exists ref_code text,
  add column if not exists status text not null default 'pending',   -- pending | approved | suspended
  add column if not exists portal_email text,
  add column if not exists fee_points numeric,                       -- referral fee in points of the loan; blank until Joe/Fiore set it
  add column if not exists tools_unlocked boolean not null default false,
  add column if not exists assigned_lo text,                         -- LO who gets this partner's borrowers (blank = normal rotation)
  add column if not exists approved_by text,
  add column if not exists approved_at timestamptz,
  add column if not exists last_login_at timestamptz,
  add column if not exists invited_by text;

-- Partners already in the CRM are Joe's own contacts: approved, each gets a link code.
update public.referral_partners set status = 'approved', approved_by = 'owner', approved_at = now() where ref_code is null and status = 'pending';
update public.referral_partners set ref_code = lower(substr(md5(id || random()::text || clock_timestamp()::text), 1, 8)) where ref_code is null;
create unique index if not exists referral_partners_ref_code_idx on public.referral_partners (ref_code) where ref_code is not null;

-- Any partner added later (CRM, import, API) gets a code automatically.
create or replace function public.referral_partner_set_code() returns trigger language plpgsql as $$
begin
  if new.ref_code is null then
    new.ref_code := lower(substr(md5(coalesce(new.id, '') || random()::text || clock_timestamp()::text), 1, 8));
  end if;
  return new;
end $$;
drop trigger if exists referral_partner_set_code on public.referral_partners;
create trigger referral_partner_set_code before insert on public.referral_partners for each row execute function public.referral_partner_set_code();

create table if not exists public.partner_login_codes (
  id bigserial primary key, partner_id text not null, code_hash text not null, expires_at timestamptz not null,
  attempts int not null default 0, created_at timestamptz not null default now()
);
create table if not exists public.partner_sessions (
  token_hash text primary key, partner_id text not null, expires_at timestamptz not null, created_at timestamptz not null default now()
);
create table if not exists public.partner_price_log (
  id bigserial primary key, partner_id text not null, created_at timestamptz not null default now()
);
-- No policies on purpose: only the service role (partner-api) can touch these.
alter table public.partner_login_codes enable row level security;
alter table public.partner_sessions enable row level security;
alter table public.partner_price_log enable row level security;
create index if not exists partner_login_codes_partner_idx on public.partner_login_codes (partner_id, created_at desc);
create index if not exists partner_price_log_partner_idx on public.partner_price_log (partner_id, created_at desc);
