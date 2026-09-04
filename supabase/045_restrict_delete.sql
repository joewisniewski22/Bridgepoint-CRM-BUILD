-- Security hardening pass 1 (2026-09-04): remove the ability to DELETE rows
-- via the anon key on every table where the app itself never issues a
-- delete. This closes a real vandalism/data-loss vector (anyone who reads
-- the public anon key out of the page source could otherwise wipe the
-- entire leads/payroll/notifications table with a single REST call) at
-- zero functional risk, since none of these delete paths are used by the
-- app's own UI.
--
-- Note on scope: this does NOT achieve per-person data isolation (an LO
-- seeing only their own leads, a borrower seeing only their own file).
-- That isn't achievable today because every client -- owner, every loan
-- officer, every processor, and every anonymous borrower -- authenticates
-- through the same custom PIN check and connects to Supabase with the
-- same public anon key; Postgres/RLS has no way to tell those requests
-- apart without a real login-session system (e.g. Supabase Auth) issuing
-- each person a verifiable, distinct credential. That's a separate,
-- larger project. This migration only removes an operation nobody
-- legitimately needs, which is safe regardless of that larger question.
--
-- users table is intentionally excluded/untouched -- it was already built
-- correctly from day one (RLS enabled, zero policies, all access only via
-- SECURITY DEFINER functions), so pins are never directly reachable.
--
-- availability_rules is intentionally excluded -- the "Remove" button on
-- My Schedule genuinely issues a real delete, so revoking it would break
-- a live feature. Can't distinguish "the rule's own owner" from anyone
-- else without the real-auth project above, so it stays as-is.

do $$
declare
  t text;
begin
  foreach t in array array[
    'ai_chat_messages', 'appointments', 'emails', 'leads',
    'market_rates', 'notifications', 'payroll_entries',
    'referral_partners', 'site_content'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', 'anon full access', t);
    execute format('create policy %I on public.%I for select to anon using (true)', 'anon select', t);
    execute format('create policy %I on public.%I for insert to anon with check (true)', 'anon insert', t);
    execute format('create policy %I on public.%I for update to anon using (true) with check (true)', 'anon update', t);
  end loop;
end $$;
