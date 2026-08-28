alter table public.leads
  add column monthly_taxes numeric,
  add column monthly_insurance numeric,
  add column monthly_hoa numeric,
  add column guideline_check jsonb;
