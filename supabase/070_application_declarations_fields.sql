alter table public.leads add column if not exists built_year integer;
alter table public.leads add column if not exists current_lender_name text;
alter table public.leads add column if not exists units_ready_for_rent text;
alter table public.leads add column if not exists property_occupied text;
alter table public.leads add column if not exists taxes_current text;
