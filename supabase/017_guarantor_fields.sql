alter table public.leads
  add column entity_legal_name text,
  add column guarantor_name text,
  add column guarantor_phone text,
  add column guarantor_email text,
  add column guarantor_ownership_pct numeric;
