-- Supports the daily 20-call-per-LO relationship/win-back queue: tracks how
-- many times a lead has been skipped in that queue (never counts as a real
-- contact attempt) and the last date it was skipped, so a skip removes it
-- from today's list without it reappearing on the next render, and a cold
-- lead skipped repeatedly with no contact eventually auto-demotes to lost.
alter table public.leads add column if not exists skip_count integer default 0;
alter table public.leads add column if not exists last_skip_at date;
