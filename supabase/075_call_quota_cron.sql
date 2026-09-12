-- Fires every 15 minutes; check-call-quota itself is a no-op outside its
-- two Eastern-time checkpoint windows (2:00pm and 4:30pm), computed inside
-- the function so DST doesn't require touching this schedule twice a year.
select cron.schedule(
  'check-call-quota',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://idzkigmvovehjpapatxv.supabase.co/functions/v1/check-call-quota',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlkemtpZ212b3ZlaGpwYXBhdHh2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4Nzg0NzU5OCwiZXhwIjoyMTAzNDIzNTk4fQ.RJt-vjJH5OY1lZrJWttZ7OHvQzo0FzuaFUtZfopv_30'),
    body := '{}'::jsonb
  );
  $$
);
