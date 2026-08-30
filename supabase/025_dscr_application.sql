-- Completed DSCR/Portfolio Business Purpose Loan Application data,
-- collected in the borrower's fill-as-you-scroll application flow and used
-- to generate the completed PDF filed onto the loan.
alter table public.leads add column if not exists dscr_app jsonb;
