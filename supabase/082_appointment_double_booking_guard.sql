-- The public booking page had no server-side guard against two people
-- grabbing the same slot at once (or one double-click submitting twice)
-- -- appointments only had a primary key on id, nothing on (user_id,
-- start_at). Found 2026-09-24. A partial unique index (only against
-- 'scheduled' rows) lets a canceled appointment free its old slot back up
-- without blocking a new booking into it.
create unique index if not exists appointments_no_double_book
  on public.appointments (user_id, start_at)
  where status = 'scheduled';
