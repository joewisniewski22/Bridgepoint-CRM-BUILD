-- 105: five tables had RLS OFF with anon read/write. Only edge functions (service role, bypasses RLS) use them,
-- so turning RLS on with no policies closes them to everyone else. Also close the two reporting views to anon.
alter table public.call_quota_reminders enable row level security;
alter table public.social_posts enable row level security;
alter table public.team_polls enable row level security;
alter table public.voice_direct_dial_pairs enable row level security;
alter table public.voice_ring_groups enable row level security;
revoke all on public.call_quota_reminders, public.social_posts, public.team_polls, public.voice_direct_dial_pairs, public.voice_ring_groups from anon;
revoke select on public.loan_tape, public.lead_source_performance from anon;
