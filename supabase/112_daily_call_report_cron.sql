select cron.schedule('daily-call-report', '*/10 * * * *', $$
  select net.http_post(
    url := 'https://idzkigmvovehjpapatxv.supabase.co/functions/v1/daily-call-report',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object('secret', (select secret from public.ad_followup_auth where id = 1)),
    timeout_milliseconds := 30000
  );
$$);
