-- Joe's ask (2026-09-28): a place for every employee to submit their own
-- direct-deposit/ACH info once, so Joe can look it up when he's about to
-- send someone a commission payment from his own bank -- the CRM never
-- moves money itself, this is just secure storage + lookup.
--
-- Routing/account numbers get the exact same treatment as guarantor SSN
-- (067_encrypt_guarantor_ssn.sql): encrypted at rest with pgcrypto, key
-- pulled from Supabase Vault at call time, never stored or shipped to the
-- browser in plaintext. Reuses the same 'ssn_encryption_key' Vault secret
-- Joe already set up rather than asking him to create a second one --
-- it's a generic symmetric key, not SSN-specific.
--
-- Unlike the SSN table (a column on leads), this is access-locked harder:
-- RLS is enabled with NO table-level policies at all, so a direct
-- table read/write from the client always fails regardless of role.
-- Every read and write goes through one of the SECURITY DEFINER functions
-- below, each of which does its own authorization check. That also means
-- the encrypted bytea columns never need to be excluded from some bulk
-- sync -- the table is simply never selected from directly.
create extension if not exists pgcrypto;

create table if not exists public.employee_ach (
  user_id text primary key references public.users(id) on delete cascade,
  account_holder_name text,
  bank_name text,
  account_type text,
  routing_number_encrypted bytea,
  account_number_encrypted bytea,
  account_number_last4 text,
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table public.employee_ach enable row level security;

-- Upserts the caller's own direct-deposit info, or (owner only) anyone
-- else's. Passing null/empty for routing/account leaves those two fields
-- untouched -- lets the form re-save name/bank/type edits without forcing
-- the numbers to be retyped every time.
create or replace function public.set_employee_ach(
  p_user_id text, p_account_holder_name text, p_bank_name text, p_account_type text,
  p_routing_number text, p_account_number text
)
returns void
language plpgsql
security definer
set search_path = public, vault, extensions
as $$
declare
  v_caller_id text;
  v_caller_role text;
  v_key text;
  v_existing_routing bytea;
  v_existing_account bytea;
  v_existing_last4 text;
begin
  select id, role into v_caller_id, v_caller_role from public.users where auth_id = auth.uid();
  if v_caller_id is null then
    raise exception 'not authorized';
  end if;
  if v_caller_role <> 'owner' and v_caller_id <> p_user_id then
    raise exception 'not authorized';
  end if;

  select routing_number_encrypted, account_number_encrypted, account_number_last4
    into v_existing_routing, v_existing_account, v_existing_last4
    from public.employee_ach where user_id = p_user_id;

  if p_routing_number is not null and btrim(p_routing_number) <> '' then
    select decrypted_secret into v_key from vault.decrypted_secrets where name = 'ssn_encryption_key';
    if v_key is null then raise exception 'ssn_encryption_key not configured in Vault'; end if;
    v_existing_routing := pgp_sym_encrypt(p_routing_number, v_key);
  end if;
  if p_account_number is not null and btrim(p_account_number) <> '' then
    if v_key is null then
      select decrypted_secret into v_key from vault.decrypted_secrets where name = 'ssn_encryption_key';
      if v_key is null then raise exception 'ssn_encryption_key not configured in Vault'; end if;
    end if;
    v_existing_account := pgp_sym_encrypt(p_account_number, v_key);
    v_existing_last4 := right(regexp_replace(p_account_number, '\D', '', 'g'), 4);
  end if;

  insert into public.employee_ach (
    user_id, account_holder_name, bank_name, account_type,
    routing_number_encrypted, account_number_encrypted, account_number_last4,
    updated_at, updated_by
  ) values (
    p_user_id, p_account_holder_name, p_bank_name, p_account_type,
    v_existing_routing, v_existing_account, v_existing_last4,
    now(), v_caller_id
  )
  on conflict (user_id) do update set
    account_holder_name = excluded.account_holder_name,
    bank_name = excluded.bank_name,
    account_type = excluded.account_type,
    routing_number_encrypted = excluded.routing_number_encrypted,
    account_number_encrypted = excluded.account_number_encrypted,
    account_number_last4 = excluded.account_number_last4,
    updated_at = now(),
    updated_by = v_caller_id;
end;
$$;

-- Owner-only: decrypts one employee's full routing + account number, for
-- the moment Joe is actually keying in a wire/ACH at his own bank.
create or replace function public.get_employee_ach_full(p_user_id text)
returns table (
  account_holder_name text, bank_name text, account_type text,
  routing_number text, account_number text
)
language plpgsql
security definer
set search_path = public, vault, extensions
as $$
declare
  v_caller_role text;
  v_key text;
begin
  select role into v_caller_role from public.users where auth_id = auth.uid();
  if v_caller_role <> 'owner' then
    raise exception 'not authorized';
  end if;

  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'ssn_encryption_key';
  if v_key is null then raise exception 'ssn_encryption_key not configured in Vault'; end if;

  return query
    select e.account_holder_name, e.bank_name, e.account_type,
           pgp_sym_decrypt(e.routing_number_encrypted, v_key),
           pgp_sym_decrypt(e.account_number_encrypted, v_key)
    from public.employee_ach e where e.user_id = p_user_id;
end;
$$;

-- Non-sensitive status only (submitted-or-not, bank name, account type,
-- last 4) -- what the "My Direct Deposit Info" form and the owner's
-- payroll screen both actually need most of the time, without touching
-- the encrypted columns at all.
create or replace function public.get_my_ach_status()
returns table (account_holder_name text, bank_name text, account_type text, account_number_last4 text, updated_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller_id text;
begin
  select id into v_caller_id from public.users where auth_id = auth.uid();
  if v_caller_id is null then raise exception 'not authorized'; end if;
  return query
    select e.account_holder_name, e.bank_name, e.account_type, e.account_number_last4, e.updated_at
    from public.employee_ach e where e.user_id = v_caller_id;
end;
$$;

create or replace function public.get_all_ach_status()
returns table (user_id text, account_holder_name text, bank_name text, account_type text, account_number_last4 text, updated_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller_role text;
begin
  select role into v_caller_role from public.users where auth_id = auth.uid();
  if v_caller_role <> 'owner' then raise exception 'not authorized'; end if;
  return query
    select e.user_id, e.account_holder_name, e.bank_name, e.account_type, e.account_number_last4, e.updated_at
    from public.employee_ach e;
end;
$$;

grant execute on function public.set_employee_ach(text, text, text, text, text, text) to authenticated;
grant execute on function public.get_employee_ach_full(text) to authenticated;
grant execute on function public.get_my_ach_status() to authenticated;
grant execute on function public.get_all_ach_status() to authenticated;

-- Joe's ask: a transaction ID (and paid date/who marked it) on top of the
-- existing outstanding/paid status, so a payroll entry is traceable back
-- to the actual bank transfer once it's sent.
alter table public.payroll_entries add column if not exists transaction_id text;
alter table public.payroll_entries add column if not exists paid_at timestamptz;
alter table public.payroll_entries add column if not exists paid_by text references public.users(id);
