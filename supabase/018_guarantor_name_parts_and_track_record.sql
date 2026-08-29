alter table public.leads
  add column guarantor_first_name text,
  add column guarantor_middle_name text,
  add column guarantor_last_name text,
  add column track_record jsonb not null default '[]';
