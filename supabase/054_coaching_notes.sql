-- Sales coaching: AI-generated notes from real call transcripts (Quo),
-- lost-deal post-mortems, and on-demand "what to say next time with this
-- client" tips. Internal only -- staff/owner, never borrower-facing, and
-- deliberately never sends anything to the client (Joe: "I don't want to
-- increase texts"). Loan officers only -- Erika doesn't sell.
create table if not exists public.coaching_notes (
  id text primary key,
  lead_id text references public.leads(id) on delete cascade,
  staff_id text not null,
  source text not null, -- 'call' | 'lost_deal' | 'next_time'
  note text not null,
  created_at timestamptz not null default now(),
  read boolean not null default false
);
create index if not exists coaching_notes_staff_idx on public.coaching_notes (staff_id, created_at);

alter table public.coaching_notes enable row level security;

-- Same broad-access baseline as team_messages/notifications (staff share
-- the anon/authenticated key for non-leads tables so far) -- no delete
-- policy, matching every other table's pass-1 hardening.
create policy "anon select coaching_notes" on public.coaching_notes for select to anon using (true);
create policy "anon insert coaching_notes" on public.coaching_notes for insert to anon with check (true);
create policy "anon update coaching_notes" on public.coaching_notes for update to anon using (true);
create policy "authenticated select coaching_notes" on public.coaching_notes for select to authenticated using (true);
create policy "authenticated insert coaching_notes" on public.coaching_notes for insert to authenticated with check (true);
create policy "authenticated update coaching_notes" on public.coaching_notes for update to authenticated using (true);
