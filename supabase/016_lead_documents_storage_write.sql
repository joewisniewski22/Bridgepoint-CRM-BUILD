create policy "anon write lead-documents" on storage.objects for insert to anon with check (bucket_id = 'lead-documents');
