-- Lets processors flag a file as paused/stalled during processing without
-- pulling it out of the real pipeline the way Cold/Lost would (those stay
-- LO/owner-only status changes -- On Hold is a separate flag on top of an
-- otherwise-active loan, not a new status value, so it doesn't need to be
-- threaded through every status==="active" check across the app).
alter table public.leads add column if not exists on_hold boolean default false;
