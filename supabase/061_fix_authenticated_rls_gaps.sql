-- Systemic audit (2026-09-08) after finding the same class of bug twice
-- in one session (leads' original policies, then availability_rules /
-- appointments): 046_staff_auth_and_lead_rls.sql gave staff real
-- authenticated Supabase sessions, but RLS has no default-allow, and
-- every table below only ever had an "anon"-role policy from before that
-- migration existed. Queried pg_policies directly for every RLS-enabled
-- table missing an authenticated-role policy despite having an anon one
-- -- these 7 are the result. Most severe: notifications was completely
-- empty for every logged-in user (verified live: 66 real rows, 0 visible
-- under an authenticated session) -- the in-app notification bell has
-- been silently broken for every staff member since 046 shipped, even
-- though the text/email side-channel alerts still worked (those go
-- through edge functions using the service role key, which bypasses RLS
-- entirely). Same permissive pattern as every table's existing anon
-- policy, and the pattern already used for team_messages in 052.
create policy "authenticated full access" on public.ai_chat_messages for all to authenticated using (true) with check (true);
create policy "authenticated full access" on public.emails for all to authenticated using (true) with check (true);
create policy "authenticated full access" on public.market_rates for all to authenticated using (true) with check (true);
create policy "authenticated full access" on public.notifications for all to authenticated using (true) with check (true);
create policy "authenticated full access" on public.payroll_entries for all to authenticated using (true) with check (true);
create policy "authenticated full access" on public.referral_partners for all to authenticated using (true) with check (true);
create policy "authenticated full access" on public.site_content for all to authenticated using (true) with check (true);
