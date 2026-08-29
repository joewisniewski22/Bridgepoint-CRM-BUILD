alter table public.leads add column application_token text;
update public.leads set application_token = md5(random()::text || id) where application_token is null;
