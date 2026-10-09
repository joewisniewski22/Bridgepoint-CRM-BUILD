-- Instant call-connect (Joe 2026-10-09): every new lead calls the new-lead-ring function,
-- which rings the assigned LO's cell and connects them when they press 1. The function
-- itself decides (source, phone, business hours in the LO's zone, one ring per lead).
create table if not exists public.lead_ring_log (
  lead_id text primary key,
  user_id text,
  created_at timestamptz not null default now(),
  result text
);
alter table public.lead_ring_log enable row level security;

create or replace function public.ring_lo_for_new_lead()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.phone is not null and coalesce(new.status, 'active') = 'active' then
    perform net.http_post(
      url := 'https://idzkigmvovehjpapatxv.supabase.co/functions/v1/new-lead-ring',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object('leadId', new.id, 'secret', (select secret from public.ad_followup_auth where id = 1)),
      timeout_milliseconds := 30000
    );
  end if;
  return new;
end;
$$;

drop trigger if exists ring_lo_for_new_lead on public.leads;
create trigger ring_lo_for_new_lead after insert on public.leads
  for each row execute function public.ring_lo_for_new_lead();
