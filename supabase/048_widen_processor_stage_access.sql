-- 046's processor RLS policy allowed visibility/writes from "processing"
-- stage onward but was missing "approved" (Conditional Approval) and
-- "postclosing" -- both clearly still within a processor's working
-- pipeline once a file has moved to processing. Joe confirmed explicitly
-- (2026-09-04): Erika should see a file once it's moved to Processing,
-- not before -- so this widens the list to cover the rest of her actual
-- pipeline, without reaching back to earlier pre-processing stages.

drop policy "staff select scoped" on public.leads;
drop policy "staff update scoped" on public.leads;

create policy "staff select scoped" on public.leads for select to authenticated using (
  exists (
    select 1 from public.current_app_user() u
    where u.app_role = 'owner'
       or u.app_id = leads.assigned_to
       or (u.app_role = 'processor' and leads.stage in ('processing','underwriting','approved','ctc','closed','postclosing'))
  )
);
create policy "staff update scoped" on public.leads for update to authenticated using (
  exists (
    select 1 from public.current_app_user() u
    where u.app_role = 'owner'
       or u.app_id = leads.assigned_to
       or (u.app_role = 'processor' and leads.stage in ('processing','underwriting','approved','ctc','closed','postclosing'))
  )
);
