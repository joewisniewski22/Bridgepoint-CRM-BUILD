create table if not exists public.company_ae (id text primary key default 'default', ae_name text, ae_email text, updated_by text, updated_at timestamptz not null default now());
alter table public.company_ae enable row level security;
drop policy if exists inner_circle_all on public.company_ae;
create policy inner_circle_all on public.company_ae for all to authenticated using (is_staff() and exists (select 1 from public.current_app_user() u where u.app_id in ('owner','lo-fiore','proc-erika'))) with check (is_staff() and exists (select 1 from public.current_app_user() u where u.app_id in ('owner','lo-fiore','proc-erika')));
insert into public.company_ae (id, ae_name, ae_email) select 'default', ae_name, ae_email from public.company_settings where id = 'default' on conflict (id) do nothing;
update public.company_settings set ae_name = null, ae_email = null where id = 'default';
select (select count(*) from public.company_ae) ae_rows, (select ae_email from public.company_settings where id='default') leftover;
