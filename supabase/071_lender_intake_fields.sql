alter table public.leads add column if not exists property_lease_status text;
alter table public.leads add column if not exists delayed_purchase text;
alter table public.leads add column if not exists ny_cema_loan text;
alter table public.leads add column if not exists ny_closing_attorney text;
