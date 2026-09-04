-- Urgent fix: this morning's staff-auth migration (046) gave real staff
-- members real Supabase Auth sessions (role "authenticated" on every
-- request), but the lead-documents storage bucket's policies only ever
-- granted access to "anon" -- so anyone who logged back in with a real
-- session (which happens automatically now) lost the ability to view or
-- upload documents entirely. Reported live: Erika and Joe couldn't see a
-- document Fanis's borrower had uploaded; Fanis could, because her
-- browser tab hadn't re-authenticated yet and was still running on the
-- old anon-only path.
--
-- Fix: grant the same access to "authenticated" too, keeping "anon" in
-- place since the public borrower-portal upload flow (?apply=id&t=token)
-- has no real session and must keep using the plain anon key.
create policy "authenticated read lead-documents" on storage.objects for select to authenticated using (bucket_id = 'lead-documents');
create policy "authenticated write lead-documents" on storage.objects for insert to authenticated with check (bucket_id = 'lead-documents');
