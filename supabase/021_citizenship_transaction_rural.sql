alter table public.leads
  add column citizenship_status text,
  add column transaction_type text,
  add column prepay_term text,
  add column rural_status text,
  add column rural_checked_at timestamptz;
