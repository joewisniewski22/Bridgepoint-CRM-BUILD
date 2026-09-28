-- Joe's ask (2026-09-28): text reminders for every appointment, whether he
-- books it or the client self-books it -- widened to the whole team, so
-- send-appointment-reminders texts whichever staff member the appointment
-- actually belongs to (appointments.user_id), same as the existing
-- send-callback-reminders does for leads.next_follow_up_at. Appointments had
-- zero reminder logic before this (booking only ever sent an email + in-app
-- notification to the host, nothing at reminder time).
create table if not exists public.appointment_reminders_sent (
  appointment_id text not null,
  start_at timestamptz not null,
  sent_at timestamptz not null default now(),
  primary key (appointment_id, start_at)
);
alter table public.appointment_reminders_sent enable row level security;
-- No anon/authenticated policy on purpose -- this is an internal dedupe
-- ledger only the service-role edge function ever touches, same as
-- callback_reminders_sent.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'send-appointment-reminders',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://idzkigmvovehjpapatxv.supabase.co/functions/v1/send-appointment-reminders',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlkemtpZ212b3ZlaGpwYXBhdHh2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4Nzg0NzU5OCwiZXhwIjoyMTAzNDIzNTk4fQ.RJt-vjJH5OY1lZrJWttZ7OHvQzo0FzuaFUtZfopv_30'),
    body := '{}'::jsonb
  );
  $$
);
