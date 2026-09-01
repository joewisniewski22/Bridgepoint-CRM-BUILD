-- Per-lead switch letting any staff member stop client-facing AI
-- automation (texts/emails/campaigns to that borrower) once they've
-- personally hooked the client. Never touches internal AI scanning
-- (document review, guideline checks, etc.) -- those have no
-- representation in this flag at all.
alter table public.leads add column if not exists automation_paused boolean default false;
