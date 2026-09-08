-- Real bug: Taeya's booking link kept showing "no availability" when SHE
-- or Joe tested it -- but it worked fine in a logged-out/anonymous
-- browser. Root cause: 044_scheduling.sql only ever granted "anon full
-- access" on availability_rules and appointments. Before
-- 046_staff_auth_and_lead_rls.sql, every client shared the plain anon
-- key, so that was equivalent to "everyone." Once staff started getting
-- real authenticated Supabase sessions (046), anyone logged in got
-- ZERO rows on these two tables -- there was never a matching policy for
-- the authenticated role, and RLS has no default-allow. The public
-- booking page (?book=) queries these tables with whatever session the
-- browser happens to hold, logged in or not, so this broke it for any
-- staff member checking a booking link (their own or a teammate's)
-- while signed in, which is exactly what Joe and Taeya were doing.
create policy "authenticated full access" on public.availability_rules for all to authenticated using (true) with check (true);
create policy "authenticated full access" on public.appointments for all to authenticated using (true) with check (true);
