-- Encrypts guarantor SSN at rest instead of storing it in plaintext.
-- The encryption key itself lives in Supabase Vault (supabase_vault
-- extension, already enabled on this project) as the secret named
-- 'ssn_encryption_key' -- created separately via
-- `select vault.create_secret('<real key>', 'ssn_encryption_key', '...')`
-- (NOT committed to this file/repo). Only SECURITY DEFINER functions
-- below read it via vault.decrypted_secrets; the anon/authenticated roles
-- never see the raw key. (ALTER DATABASE ... SET was tried first but
-- Supabase's hosted role doesn't have permission to set custom GUCs --
-- Vault is the actual supported mechanism for this.)
create extension if not exists pgcrypto;

alter table public.leads add column if not exists guarantor_ssn_encrypted bytea;
alter table public.leads add column if not exists guarantor_ssn_last4 text;

-- The old plaintext column was added same-day (066_guarantor_ssn.sql) and
-- never held a real client's SSN -- only a test value, already cleared --
-- so this is a clean cutover, not a migration of real sensitive data.
alter table public.leads drop column if exists guarantor_ssn;

-- Encrypts and stores a guarantor SSN for a lead. Also keeps a plaintext
-- last-4 alongside for cheap masked display (e.g. "...6789" on a document)
-- without ever decrypting the full number just to show a mask.
-- Passing null/empty clears both fields.
create or replace function public.set_guarantor_ssn(p_lead_id text, p_ssn text)
returns void
language plpgsql
security definer
set search_path = public, vault, extensions
as $$
declare
  v_key text;
begin
  if p_ssn is null or btrim(p_ssn) = '' then
    update public.leads set guarantor_ssn_encrypted = null, guarantor_ssn_last4 = null where id = p_lead_id;
    return;
  end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'ssn_encryption_key';
  if v_key is null then
    raise exception 'ssn_encryption_key not configured in Vault';
  end if;
  update public.leads
  set guarantor_ssn_encrypted = pgp_sym_encrypt(p_ssn, v_key),
      guarantor_ssn_last4 = right(regexp_replace(p_ssn, '\D', '', 'g'), 4)
  where id = p_lead_id;
end;
$$;

-- Decrypts the full SSN for a lead. Not currently called from the CRM UI
-- (nothing there needs the full number back) -- kept available server-side
-- for a future "reveal" feature (e.g. for an actual credit pull), gated to
-- staff who can already see this lead per the app's own role rules.
create or replace function public.get_guarantor_ssn_full(p_lead_id text)
returns text
language plpgsql
security definer
set search_path = public, vault, extensions
as $$
declare
  v_caller_id text;
  v_caller_role text;
  v_caller_full_access boolean;
  v_lead_assigned_to text;
  v_key text;
  v_ssn text;
begin
  select id, role, coalesce(full_access, false) into v_caller_id, v_caller_role, v_caller_full_access
  from public.users where auth_id = auth.uid();

  if v_caller_id is null then
    raise exception 'not authorized';
  end if;

  select assigned_to into v_lead_assigned_to from public.leads where id = p_lead_id;

  if v_caller_role <> 'owner' and v_caller_full_access is not true and v_lead_assigned_to <> v_caller_id then
    raise exception 'not authorized';
  end if;

  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'ssn_encryption_key';
  if v_key is null then
    raise exception 'ssn_encryption_key not configured in Vault';
  end if;

  select pgp_sym_decrypt(guarantor_ssn_encrypted, v_key) into v_ssn
  from public.leads where id = p_lead_id;
  return v_ssn;
end;
$$;

-- anon too: the public borrower-facing application form (no staff login)
-- also needs to be able to submit a real SSN for itself.
grant execute on function public.set_guarantor_ssn(text, text) to authenticated, anon;
grant execute on function public.get_guarantor_ssn_full(text) to authenticated;
