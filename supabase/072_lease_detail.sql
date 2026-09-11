alter table public.leads add column if not exists num_units integer;
alter table public.leads add column if not exists lease_detail jsonb default '[]'::jsonb;
