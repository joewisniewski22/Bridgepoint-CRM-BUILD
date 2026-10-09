-- 5-minute lead handoff (Joe 2026-10-09): "their phone rings and they don't answer in 5 minutes
-- or call back in 5 minutes the lead gets automatically reassigned to next on list". Daytime only
-- (9am-10pm ET); overnight leads stay put; Spanish/language leads never move. The lead-handoff
-- function (cron, every minute) does the work; this is its bookkeeping.

-- When the LO actually dialed the borrower (press 1 on the ring, the in-app phone, direct dial).
-- Texts don't count -- Joe's rule is a call.
alter table public.leads add column if not exists lo_dialed_at timestamptz;

create table if not exists public.lead_handoff (
  lead_id text primary key,
  pool text not null,                       -- 'english' | 'ci'
  first_lo text,                            -- who the rotation originally gave it to
  tried text[] not null default '{}',       -- LOs who've had their 5 minutes
  clock_start timestamptz not null,         -- when the current LO's 5 minutes started
  moves int not null default 0,
  status text not null default 'watching',  -- watching | worked | final | night
  updated_at timestamptz not null default now()
);
alter table public.lead_handoff enable row level security;

-- One-shot alerts (Spanish 15-min, overnight noon backstop, 9am morning ring) so cron never repeats them.
create table if not exists public.lead_handoff_alerts (
  lead_id text not null,
  kind text not null,
  created_at timestamptz not null default now(),
  primary key (lead_id, kind)
);
alter table public.lead_handoff_alerts enable row level security;

select cron.schedule('lead-handoff', '* * * * *', $$
  select net.http_post(
    url := 'https://idzkigmvovehjpapatxv.supabase.co/functions/v1/lead-handoff',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object('secret', (select secret from public.ad_followup_auth where id = 1)),
    timeout_milliseconds := 55000
  );
$$);
