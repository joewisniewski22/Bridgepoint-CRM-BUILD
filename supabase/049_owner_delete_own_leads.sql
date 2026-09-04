-- Joe asked for a delete button -- clarified: only the owner role can
-- delete, but for any lead regardless of who it's assigned to (not
-- restricted to his own). 045 removed anon DELETE entirely (no in-app
-- feature used it at the time); 046 never added a DELETE policy for
-- authenticated staff either. LOs and processors still have no delete
-- path at all, in the UI or at the database level.
create policy "owner delete any lead" on public.leads for delete to authenticated using (
  exists (
    select 1 from public.current_app_user() u
    where u.app_role = 'owner'
  )
);
