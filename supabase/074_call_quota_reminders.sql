-- Dedup ledger for the daily call-quota text reminders (check-call-quota
-- function). A row here means that checkpoint's reminder already went out
-- to that user today -- the unique primary key makes the insert-then-send
-- pattern atomic, so an overlapping/retried cron tick can never double-text
-- someone.
create table if not exists public.call_quota_reminders (
  user_id text not null,
  reminder_date date not null,
  checkpoint text not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, reminder_date, checkpoint)
);
