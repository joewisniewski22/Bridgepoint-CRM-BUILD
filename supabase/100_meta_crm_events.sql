-- Meta conversion feedback (Joe 2026-10-09: "do everything in your power to maximize roi").
-- When a Facebook lead-form lead moves down the funnel in the CRM, we tell Meta (Conversions
-- API, CRM integration: user_data.lead_id = the Facebook leadgen id), so Meta's delivery learns
-- which people become applications and closed loans instead of just form fills.

alter table public.leads add column if not exists meta_leadgen_id text;

create table if not exists public.meta_crm_events (
  lead_id text not null,
  event_name text not null,
  sent_at timestamptz not null default now(),
  response text,
  primary key (lead_id, event_name)
);
alter table public.meta_crm_events enable row level security;

create or replace function public.meta_crm_event_on_stage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.meta_leadgen_id is not null
     and (new.stage is distinct from old.stage or new.status is distinct from old.status or (old.lo_dialed_at is null and new.lo_dialed_at is not null)) then
    perform net.http_post(
      url := 'https://idzkigmvovehjpapatxv.supabase.co/functions/v1/meta-crm-events',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object('leadId', new.id, 'secret', (select secret from public.ad_followup_auth where id = 1)),
      timeout_milliseconds := 20000
    );
  end if;
  return new;
end;
$$;

drop trigger if exists meta_crm_event_on_stage on public.leads;
create trigger meta_crm_event_on_stage after update on public.leads
  for each row execute function public.meta_crm_event_on_stage();
