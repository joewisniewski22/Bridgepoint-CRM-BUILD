-- For deals that don't fit Constructive Loans in-house guidelines, Joe/
-- Fiore can route the deal to an outside wholesale lender (Kiavi, RELIP,
-- RCN). Erika sees the destination (read-only, so she knows where to send
-- docs) but doesn't pick it. Every other LO only ever sees "Needs Review"
-- on the existing guideline check -- this field is deliberately never
-- rendered to them client-side. No new lender rate matrices yet; this is
-- just the routing/visibility structure Joe asked to have ready first.
alter table public.leads add column if not exists outside_lender text;
