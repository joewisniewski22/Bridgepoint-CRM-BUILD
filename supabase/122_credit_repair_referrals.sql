create table if not exists public.credit_repair_referrals (
  id uuid primary key default gen_random_uuid(),
  lead_id text not null,
  lead_name text not null,
  phone text,
  email text,
  issue text,
  referred_by text,
  client_consented boolean not null default false,
  consented_at timestamptz,
  status text not null default 'queued',
  partner text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
alter table public.credit_repair_referrals enable row level security;
drop policy if exists "staff queue referrals" on public.credit_repair_referrals;
create policy "staff queue referrals" on public.credit_repair_referrals for insert to authenticated with check (is_staff());
drop policy if exists "staff read own referrals" on public.credit_repair_referrals;
create policy "staff read own referrals" on public.credit_repair_referrals for select to authenticated using (is_staff() and (referred_by = (select u.app_id from public.current_app_user() u limit 1) or exists (select 1 from public.current_app_user() u where u.app_id in ('owner','lo-fiore','proc-erika'))));
drop policy if exists "owner manages referrals" on public.credit_repair_referrals;
create policy "owner manages referrals" on public.credit_repair_referrals for update to authenticated using (exists (select 1 from public.current_app_user() u where u.app_id in ('owner','lo-fiore','proc-erika'))) with check (true);
drop policy if exists "owner deletes referrals" on public.credit_repair_referrals;
create policy "owner deletes referrals" on public.credit_repair_referrals for delete to authenticated using (exists (select 1 from public.current_app_user() u where u.app_id = 'owner'));
select count(*) from public.credit_repair_referrals;
