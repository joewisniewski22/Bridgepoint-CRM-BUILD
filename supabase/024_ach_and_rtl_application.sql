-- Completed ACH authorization + RTL Business Purpose Loan Application data,
-- collected in the borrower's fill-as-you-scroll application flow and used
-- to generate the completed PDFs filed onto the loan.
alter table public.leads add column if not exists ach_form jsonb;
alter table public.leads add column if not exists rtl_app jsonb;
