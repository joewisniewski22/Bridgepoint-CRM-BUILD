-- Questions lenders ask that our application didn't (found while mapping Velocity 10/14/26): estimated closing date, short-term rental.
alter table public.leads add column if not exists est_closing_date date;
alter table public.leads add column if not exists short_term_rental text;
-- Registry of every question each lender asks and how our system answers it (Joe 10/14/26: remember what each lender asks, and make sure the
-- app asks it or the answer is derivable from the app).
create table if not exists public.lender_questions (
  id bigserial primary key,
  lender text not null,
  screen text,
  question text not null,
  field_ref text,                -- the lender's own field id / label
  required boolean default false,
  our_source text,               -- where the answer comes from in our system, or how it is derived
  status text not null default 'covered',   -- covered | derived | added | gap
  notes text,
  first_seen date default current_date,
  unique (lender, screen, question)
);
alter table public.lender_questions enable row level security;
