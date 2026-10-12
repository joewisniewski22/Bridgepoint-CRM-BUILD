-- 103: run AFTER 102 is applied AND the CRM build that sends p_token to set_guarantor_ssn is live.
-- Removes the old 2-argument set_guarantor_ssn (callable by anyone holding the anon key).
drop function if exists public.set_guarantor_ssn(text, text);
