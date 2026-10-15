-- Conference calls started from the dialer (Joe 2026-10-15). Written only by the conference-call and voice-webhook functions (service role);
-- staff can read them so the CRM can show who is on the call. No client access.
create table if not exists voice_conferences (
  name text primary key,
  lead_id text,
  lead_name text,
  started_by text,
  status text not null default 'ringing_staff',   -- ringing_staff | live | ended | missed | failed
  telnyx_conference_id text,
  staff_call_control_id text,
  participants jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
alter table voice_conferences enable row level security;
drop policy if exists "staff read conferences" on voice_conferences;
create policy "staff read conferences" on voice_conferences for select to authenticated using (is_staff());
