create policy "anon read lead-documents" on storage.objects for select to anon using (bucket_id = 'lead-documents');
