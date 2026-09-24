-- generate-mismo-export runs with the service-role key (auth.uid() is null
-- in that context), so it can't call get_guarantor_ssn_full -- that RPC's
-- own identity check would always reject it. This is the same decrypt,
-- minus the identity check, granted to service_role only (never
-- anon/authenticated) -- the edge function does its own caller-identity
-- check (mirroring get_guarantor_ssn_full's owner/full_access/assigned-LO
-- rule) before ever calling this. Found 2026-09-24 consolidating the two
-- competing MISMO export paths into one properly-gated one.
create or replace function public.get_guarantor_ssn_full_unchecked(p_lead_id text)
returns text
language plpgsql
security definer
set search_path = public, vault, extensions
as $$
declare
  v_key text;
  v_ssn text;
begin
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'ssn_encryption_key';
  if v_key is null then
    return null;
  end if;
  select pgp_sym_decrypt(guarantor_ssn_encrypted, v_key) into v_ssn
  from public.leads where id = p_lead_id;
  return v_ssn;
end;
$$;
revoke all on function public.get_guarantor_ssn_full_unchecked(text) from public, anon, authenticated;
grant execute on function public.get_guarantor_ssn_full_unchecked(text) to service_role;
