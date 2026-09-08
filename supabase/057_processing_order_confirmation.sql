-- Separate "LO requested it" from "Erika actually placed the order" --
-- previously a single appraisal_ordered/title_ordered flag conflated both.
alter table public.leads add column if not exists appraisal_confirmed boolean default false;
alter table public.leads add column if not exists appraisal_confirmed_at date;
alter table public.leads add column if not exists title_confirmed boolean default false;
alter table public.leads add column if not exists title_confirmed_at date;
