-- Joe's ask (2026-09-25): company-level config (Account Executive contact,
-- company NMLS, etc.) had been getting hardcoded as JS constants in
-- index.html and the generate-mismo-export edge function -- meaning only
-- someone who can edit and redeploy source code could ever change them.
-- Single-row table, edited from a real "Settings" page in the app instead.
create table if not exists public.company_settings (
  id text primary key default 'default',
  company_name text,
  company_address text,
  company_nmls text,
  ae_name text,
  ae_email text,
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table public.company_settings enable row level security;
create policy "anon full access" on public.company_settings for all to anon using (true) with check (true);

insert into public.company_settings (id, company_name, company_address, ae_name, ae_email)
values ('default', 'Bridgepoint Lending', '1898 Merchants Row Blvd, Tallahassee, FL 32311', 'Julia Lanier', 'jlanier@cmwholesale.com')
on conflict (id) do nothing;
