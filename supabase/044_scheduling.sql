-- Self-service scheduling: each LO (or the owner) sets recurring weekly
-- availability windows; a public, unauthenticated booking link
-- (?book=<userId>) lets a prospect or borrower pick an open slot without
-- staff having to go back and forth. All times are naive/local (same
-- convention the rest of this app already uses -- no other feature does
-- real timezone conversion either), consistent with the practical reality
-- that Bridgepoint and its borrowers are effectively all Eastern time.
create table if not exists public.availability_rules (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  day_of_week int not null, -- 0=Sunday .. 6=Saturday
  start_minutes int not null, -- minutes since midnight, local wall time
  end_minutes int not null,
  slot_minutes int not null default 30,
  created_at timestamptz not null default now()
);
alter table public.availability_rules enable row level security;
create policy "anon full access" on public.availability_rules for all to anon using (true) with check (true);

create table if not exists public.appointments (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  lead_id text references public.leads(id) on delete set null,
  name text not null,
  phone text,
  email text,
  notes text,
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null default 'scheduled', -- scheduled | canceled
  created_at timestamptz not null default now()
);
alter table public.appointments enable row level security;
create policy "anon full access" on public.appointments for all to anon using (true) with check (true);
