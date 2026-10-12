-- 107: the lead-documents bucket (borrower IDs, bank statements, applications) allowed anyone with the public key to
-- read and upload. The borrower page now uploads and opens files through portal-api (token-checked, inside that
-- file's own folder), so the anonymous storage policies are removed. Signed-in staff keep theirs.
drop policy if exists "anon read lead-documents" on storage.objects;
drop policy if exists "anon write lead-documents" on storage.objects;
