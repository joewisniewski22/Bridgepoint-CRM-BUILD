-- Schedule of Real Estate Owned (SREO): properties a borrower currently owns, asked on every application
-- (Joe 2026-10-14). Rows: {address, propertyType, purchaseYear, purchasePrice, currentValue, loanBalance, monthlyRent, occupancy}.
alter table public.leads add column if not exists reo jsonb not null default '[]';
alter table public.leads add column if not exists reo_owns text;
