-- Underwriting conditions: processor writes a description (plus an
-- optional reference file), which goes out to both the borrower and the
-- loan officer immediately, and the borrower can upload their response
-- file back against that specific condition.
alter table public.leads add column if not exists uw_conditions jsonb default '[]'::jsonb;
