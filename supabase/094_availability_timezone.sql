-- Time zones for scheduling (Joe 10/9/26: "make sure our calendars adjust for timezones").
-- Each staff member's weekly hours are wall-clock times in THEIR time zone. The booking
-- page converts those to real moments and shows them in the visitor's own time zone;
-- reminder texts use the staff member's zone. Existing rows were set up as Eastern.
alter table public.availability_rules add column if not exists timezone text not null default 'America/New_York';
