-- Lets a trusted staff member (same allowlist as outside-lender management:
-- owner, Fiore, Erika -- see canManageOutsideLender() in index.html) mark a
-- specific in-house loan as approved above Constructive Capital's standard
-- guideline matrix, when a real, already-negotiated number exceeds the
-- standard LTC/LTARV tables (e.g. an AE-approved exception). Without this,
-- buildTermSheet() silently re-caps the printed loan amount back down to
-- the standard guideline max, which is correct for a normal file but wrong
-- once a real exception has actually been approved -- found 2026-09-22 on
-- Gnana Bolisetti's file (Fiore's real $222,500 was being capped to
-- $213,750 on the generated term sheet).
alter table public.leads add column if not exists guideline_override_approved boolean default false;
alter table public.leads add column if not exists guideline_override_note text;
