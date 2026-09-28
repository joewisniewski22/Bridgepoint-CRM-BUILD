-- Joe's ask (2026-09-28): a daily "you have these appointments today" text
-- to everyone at 8am, on top of the existing per-item reminders (which he
-- also asked to move from 30/at-due-time to a consistent 10-minutes-before
-- across the board -- see the code changes to send-callback-reminders and
-- send-appointment-reminders alongside this migration).
--
-- One claim row per calendar day (not per user) -- the function processes
-- every staff member's schedule in a single run, so the whole batch either
-- sends or doesn't as one unit.
create table if not exists public.daily_schedule_sent (
  reminder_date date primary key,
  sent_at timestamptz not null default now()
);
alter table public.daily_schedule_sent enable row level security;
-- No anon/authenticated policy on purpose -- internal dedupe ledger only
-- the service-role edge function touches, same as the other *_sent tables.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- cron.schedule('send-daily-schedule', '*/10 * * * *', $$ select net.http_post(
--   url := 'https://idzkigmvovehjpapatxv.supabase.co/functions/v1/send-daily-schedule',
--   headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer <service-role JWT>'),
--   body := '{}'::jsonb
-- ); $$);
-- The actual cron.schedule() call (with the real service-role key filled in)
-- is left out of this file on purpose -- run it directly in the Supabase SQL
-- editor, same as the other two cron migrations in this repo that also had
-- to be applied by hand (086_appointment_reminders_cron.sql and, before it,
-- whatever originally registered send-callback-reminders with no tracked
-- migration at all).
