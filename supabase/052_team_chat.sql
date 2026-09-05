-- Internal team direct-messaging: staff can message each other directly
-- inside the CRM instead of texting/emailing outside it. Simple 1:1 DMs,
-- not group channels -- matches what Joe asked for.
create table if not exists public.team_messages (
  id text primary key,
  from_user_id text not null,
  to_user_id text not null,
  body text not null,
  created_at timestamptz not null default now(),
  read boolean not null default false
);
create index if not exists team_messages_participants_idx on public.team_messages (from_user_id, to_user_id, created_at);

alter table public.team_messages enable row level security;

-- Same broad-anon-access pattern as notifications/emails/etc. (pre-045
-- baseline) -- staff share the anon key for now, real per-role auth only
-- covers leads so far (see the staff-auth RLS work). No delete policy,
-- matching the pass-1 hardening on every other table.
create policy "anon select team_messages" on public.team_messages for select to anon using (true);
create policy "anon insert team_messages" on public.team_messages for insert to anon with check (true);
create policy "anon update team_messages" on public.team_messages for update to anon using (true);
create policy "authenticated select team_messages" on public.team_messages for select to authenticated using (true);
create policy "authenticated insert team_messages" on public.team_messages for insert to authenticated with check (true);
create policy "authenticated update team_messages" on public.team_messages for update to authenticated using (true);
