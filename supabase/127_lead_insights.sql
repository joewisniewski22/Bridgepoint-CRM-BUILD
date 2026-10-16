-- Joe 2026-10-16: "when notes are entered on a call, system wide, they need to be scanned and implemented into follow-ups, and the AI should learn
-- from the notes for custom communication with the clients and LOs."
-- lead_insights = durable facts the scanner pulled out of staff notes (preferences, objections, timeline, issues, commitments, suggested deal updates).
-- note_scan_log = one row per note already scanned (so each note is read exactly once). Written only by the scan-notes function (service role).
create table if not exists lead_insights (
  id uuid primary key default gen_random_uuid(),
  lead_id text not null,
  kind text not null,                      -- preference | personal | objection | timeline | deal_fact | issue | commitment | sentiment | deal_update
  text text not null,
  source_key text,                         -- note_scan_log.key of the note it came from
  source_by text,                          -- staff id who wrote the note
  source_at timestamptz,
  active boolean not null default true,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists lead_insights_lead on lead_insights (lead_id, active);
alter table lead_insights enable row level security;
drop policy if exists "staff read insights" on lead_insights;
create policy "staff read insights" on lead_insights for select to authenticated
  using (exists (select 1 from leads l where l.id = lead_insights.lead_id));   -- leads' own RLS decides who can see the file
drop policy if exists "staff hide insights" on lead_insights;
create policy "staff hide insights" on lead_insights for update to authenticated
  using (exists (select 1 from leads l where l.id = lead_insights.lead_id))
  with check (exists (select 1 from leads l where l.id = lead_insights.lead_id));

create table if not exists note_scan_log (
  key text primary key,
  lead_id text not null,
  scanned_at timestamptz not null default now(),
  result jsonb not null default '{}'::jsonb
);
create index if not exists note_scan_log_lead on note_scan_log (lead_id);
alter table note_scan_log enable row level security;   -- no policies: service role only
