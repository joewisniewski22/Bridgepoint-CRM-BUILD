-- 102: close unauthenticated access to privileged database functions (found 10/12/2026).
-- Until now anyone holding the public (anon) key could call reset_pin / create_user /
-- set_origination_split / save_signature / etc. directly -- reset the owner's PIN, add a staff
-- user, change a loan officer's comp split, rewrite email signatures, overwrite a guarantor SSN.
-- Fix: (1) owner-only / self-only checks INSIDE the functions, (2) EXECUTE revoked from anon and
-- PUBLIC on everything except the few functions the public pages really call.
-- Part A only. The old 2-arg set_guarantor_ssn stays callable until the client that sends the
-- application token is deployed (see 103_drop_old_guarantor_ssn.sql).

-- ---------------------------------------------------------------- owner-only
create or replace function public.reset_pin(p_user_id text, p_new_pin text)
returns void language plpgsql security definer set search_path to 'public' as $f$
begin
  if coalesce((select app_role from public.current_app_user() limit 1), '') <> 'owner' then
    raise exception 'not authorized';
  end if;
  update public.users set pin = p_new_pin where id = p_user_id;
end;
$f$;

create or replace function public.set_origination_split(p_user_id text, p_split numeric)
returns void language plpgsql security definer set search_path to 'public' as $f$
begin
  if coalesce((select app_role from public.current_app_user() limit 1), '') <> 'owner' then
    raise exception 'not authorized';
  end if;
  update public.users set origination_split = p_split where id = p_user_id;
end;
$f$;

create or replace function public.set_quo_phone_number(p_user_id text, p_quo_phone_number text)
returns void language plpgsql security definer set search_path to 'public' as $f$
begin
  if coalesce((select app_role from public.current_app_user() limit 1), '') <> 'owner' then
    raise exception 'not authorized';
  end if;
  update public.users set quo_phone_number = p_quo_phone_number where id = p_user_id;
end;
$f$;

-- create_user (three overloads): inject the owner check right after the first BEGIN.
do $do$
declare r record; def text;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'create_user' loop
    def := pg_get_functiondef(r.oid);
    def := regexp_replace(def, E'\\mbegin\\M',
      E'begin\n  if coalesce((select app_role from public.current_app_user() limit 1), '''') <> ''owner'' then raise exception ''not authorized''; end if;');
    execute def;
  end loop;
end
$do$;

-- ------------------------------------------------------- self (or owner) only
create or replace function public.change_pin(p_user_id text, p_old_pin text, p_new_pin text)
returns boolean language plpgsql security definer set search_path to 'public' as $f$
declare me text; ok boolean;
begin
  select app_id into me from public.current_app_user() limit 1;
  if me is null or me <> p_user_id then return false; end if;
  select true into ok from public.users where id = p_user_id and pin = p_old_pin;
  if ok is null then return false; end if;
  update public.users set pin = p_new_pin where id = p_user_id;
  return true;
end;
$f$;

create or replace function public.save_signature(p_user_id text, p_email_signature text, p_text_signoff text, p_nmls text default null)
returns void language plpgsql security definer set search_path to 'public' as $f$
declare me record;
begin
  select * into me from public.current_app_user() limit 1;
  if me.app_id is null or (me.app_id <> p_user_id and me.app_role <> 'owner') then raise exception 'not authorized'; end if;
  update public.users set email_signature = p_email_signature, text_signoff = p_text_signoff, onboarded = true,
    nmls_number = coalesce(p_nmls, nmls_number) where id = p_user_id;
end;
$f$;

create or replace function public.set_photo_url(p_user_id text, p_photo_url text)
returns void language plpgsql security definer set search_path to 'public' as $f$
declare me record;
begin
  select * into me from public.current_app_user() limit 1;
  if me.app_id is null or (me.app_id <> p_user_id and me.app_role <> 'owner') then raise exception 'not authorized'; end if;
  update public.users set photo_url = p_photo_url where id = p_user_id;
end;
$f$;

create or replace function public.set_portal_prefs(p_user_id text, p_prefs jsonb)
returns void language plpgsql security definer set search_path to 'public' as $f$
declare me record;
begin
  select * into me from public.current_app_user() limit 1;
  if me.app_id is null or (me.app_id <> p_user_id and me.app_role <> 'owner') then raise exception 'not authorized'; end if;
  update public.users set portal_prefs = p_prefs where id = p_user_id;
end;
$f$;

create or replace function public.set_speaks_spanish(p_user_id text, p_value boolean)
returns void language plpgsql security definer set search_path to 'public' as $f$
declare me record;
begin
  select * into me from public.current_app_user() limit 1;
  if me.app_id is null or (me.app_id <> p_user_id and me.app_role <> 'owner') then raise exception 'not authorized'; end if;
  update public.users set speaks_spanish = p_value where id = p_user_id;
end;
$f$;

-- --------------------------- guarantor SSN: signed-in staff OR the file's application token
create or replace function public.set_guarantor_ssn(p_lead_id text, p_ssn text, p_token text default null)
returns void language plpgsql security definer set search_path to 'public', 'vault', 'extensions' as $f$
declare v_key text; v_ok boolean := false;
begin
  if exists (select 1 from public.users where auth_id = auth.uid()) then v_ok := true; end if;
  if not v_ok and p_token is not null and exists (select 1 from public.leads where id = p_lead_id and application_token = p_token) then v_ok := true; end if;
  if not v_ok then raise exception 'not authorized'; end if;
  if p_ssn is null or btrim(p_ssn) = '' then
    update public.leads set guarantor_ssn_encrypted = null, guarantor_ssn_last4 = null where id = p_lead_id;
    return;
  end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'ssn_encryption_key';
  if v_key is null then raise exception 'ssn_encryption_key not configured in Vault'; end if;
  update public.leads
  set guarantor_ssn_encrypted = pgp_sym_encrypt(p_ssn, v_key),
      guarantor_ssn_last4 = right(regexp_replace(p_ssn, '\D', '', 'g'), 4)
  where id = p_lead_id;
end;
$f$;

-- ------------------------------------------------------------------- grants
-- Everything callable by anon today loses that (and PUBLIC), except what the public pages need.
-- Trigger functions are left alone (they are not directly callable).
do $do$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and p.prorettype <> 'trigger'::regtype
      and p.proname not in ('booking_owner', 'list_users', 'public_get_borrower_invite', 'public_submit_borrower',
                            'set_co_guarantor_ssn', 'set_guarantor_ssn')
  loop
    execute format('revoke execute on function %s from public, anon', r.sig);
    execute format('grant execute on function %s to authenticated, service_role', r.sig);
  end loop;
end
$do$;
-- the new 3-arg set_guarantor_ssn must stay callable by anon (token path) and staff
grant execute on function public.set_guarantor_ssn(text, text, text) to anon, authenticated, service_role;

-- new functions created later are NOT callable by anon/PUBLIC unless explicitly granted
alter default privileges for role postgres in schema public revoke execute on functions from public, anon;
