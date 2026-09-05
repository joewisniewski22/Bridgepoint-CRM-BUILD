-- Safety net for the AI conversion-texting automation: catches any lead
-- whose last activity is a client message that never got a reply (the
-- receive-text -> ai-lead-engage handoff failed, even after its own
-- retry) and re-engages it. Runs every 15 minutes so a stalled real
-- question from an inbound Facebook lead doesn't just sit there
-- overnight -- directly what Joe asked for ("if we wake up to completed
-- apps that's awesome").
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'sweep-stalled-conversations',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://idzkigmvovehjpapatxv.supabase.co/functions/v1/sweep-stalled-conversations',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlkemtpZ212b3ZlaGpwYXBhdHh2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4Nzg0NzU5OCwiZXhwIjoyMTAzNDIzNTk4fQ.RJt-vjJH5OY1lZrJWttZ7OHvQzo0FzuaFUtZfopv_30'),
    body := '{}'::jsonb
  );
  $$
);
