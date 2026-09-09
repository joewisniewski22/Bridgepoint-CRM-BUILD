alter table public.leads add column if not exists previous_lead_id text;
alter table public.leads add column if not exists next_lead_id text;
