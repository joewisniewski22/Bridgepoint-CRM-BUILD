-- Current/as-is value, distinct from purchase price -- needed as the LTV
-- basis for refinance transactions (a refi's purchase price, if any, is
-- often years stale and the wrong number to price leverage against).
alter table public.leads add column if not exists current_value numeric;
