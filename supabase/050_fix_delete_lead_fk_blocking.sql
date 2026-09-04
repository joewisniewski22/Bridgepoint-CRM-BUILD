-- New delete-lead feature would otherwise fail on any real lead: the
-- notifications and emails tables both reference leads(id) with the
-- default NO ACTION delete rule (unlike site_content/payroll_entries/
-- appointments, which already use SET NULL and were fine). Every real
-- lead has notification history, so this would block every real delete.
--
-- notifications are transient/no lasting value once the lead is gone --
-- cascade them. emails are a historical send log worth keeping even
-- after the lead record itself is deleted -- SET NULL instead, matching
-- the pattern already used for payroll_entries/appointments/site_content.

alter table public.notifications drop constraint notifications_lead_id_fkey;
alter table public.notifications add constraint notifications_lead_id_fkey
  foreign key (lead_id) references public.leads(id) on delete cascade;

alter table public.emails drop constraint emails_lead_id_fkey;
alter table public.emails add constraint emails_lead_id_fkey
  foreign key (lead_id) references public.leads(id) on delete set null;
