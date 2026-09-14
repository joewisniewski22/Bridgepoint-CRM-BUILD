-- Lets staff manually override the $1,200 default processing fee per loan
-- (Joe: "we will change it manually if we have to"). Null means use the
-- default -- this only stores an actual override, not a copy of the default.
alter table public.leads add column if not exists processing_fee_override numeric;
