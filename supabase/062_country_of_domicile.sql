-- Joe wants the LO to actually ask a Foreign National borrower's country
-- of citizenship in the Pricer and loan application, so the CRM can tell
-- them upfront if the borrower is on BPL's ineligible-countries list
-- (Constructive Capital's RTL Foreign Nationals appendix, 2.1.26) --
-- instead of only surfacing that as a manual-verification note.
alter table public.leads add column if not exists country_of_domicile text;
