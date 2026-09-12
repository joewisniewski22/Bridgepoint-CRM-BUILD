-- Structured lost-reason capture (was previously just a free-text activity
-- note with no way to aggregate) so real win-loss patterns -- pricing gaps,
-- qualification issues, speed problems -- surface instead of being guessed.
alter table public.leads add column if not exists lost_reason text;
alter table public.leads add column if not exists lost_reason_note text;
