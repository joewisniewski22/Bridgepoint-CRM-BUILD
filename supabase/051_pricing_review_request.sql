-- "Submit for Review" feature: an LO can flag a loan scenario for Joe to
-- personally check pricing on before they quote it. Needs to persist across
-- sessions/devices (not just localStorage) so it survives until Joe marks
-- it reviewed, and so it shows up in his queue on whatever device he opens
-- next -- hence real columns rather than stuffing it into existing JSON
-- blobs like guideline_check.

alter table public.leads add column if not exists pricing_review_requested_at timestamptz;
alter table public.leads add column if not exists pricing_review_note text;
alter table public.leads add column if not exists pricing_review_requested_by text;
alter table public.leads add column if not exists pricing_review_resolved_at timestamptz;
