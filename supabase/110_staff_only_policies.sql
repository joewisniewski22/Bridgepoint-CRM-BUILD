-- 110 (10/12/2026): "signed in" is no longer enough. Many tables allowed ANY signed-in user (policy "true" for the
-- authenticated role). That was fine while only staff could sign in, but the broker portal will give outside people
-- real logins, so every one of those policies now requires an actual staff record. Also covers the document bucket.
create or replace function public.is_staff() returns boolean language sql stable security definer set search_path to 'public' as $f$
  select exists (select 1 from public.users u where u.auth_id = auth.uid());
$f$;
revoke execute on function public.is_staff() from public, anon;
grant execute on function public.is_staff() to authenticated, service_role;

do $do$
declare r record; sql text;
begin
  for r in
    select schemaname, tablename, policyname, cmd from pg_policies
    where schemaname = 'public' and roles::text = '{authenticated}'
      and (trim(coalesce(qual, '')) = 'true' or trim(coalesce(with_check, '')) = 'true')
  loop
    sql := format('alter policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
    if r.cmd in ('ALL', 'UPDATE') then sql := sql || ' using (public.is_staff()) with check (public.is_staff())';
    elsif r.cmd in ('SELECT', 'DELETE') then sql := sql || ' using (public.is_staff())';
    elsif r.cmd = 'INSERT' then sql := sql || ' with check (public.is_staff())';
    end if;
    execute sql;
  end loop;
end
$do$;

-- documents bucket: staff only (borrowers go through portal-api)
alter policy "authenticated read lead-documents" on storage.objects using (bucket_id = 'lead-documents' and public.is_staff());
alter policy "authenticated write lead-documents" on storage.objects with check (bucket_id = 'lead-documents' and public.is_staff());
