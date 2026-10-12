-- 108: store staff PINs hashed (bcrypt) instead of in plain text (10/12/2026).
-- A trigger hashes whatever is written to users.pin (create_user, reset_pin, etc.) and clears the plain value, so
-- every existing code path keeps working. login() and change_pin() compare against the hash.
-- Everything runs in one transaction: if any existing PIN fails to verify against its new hash, nothing changes.
alter table public.users add column if not exists pin_hash text;
update public.users set pin_hash = extensions.crypt(pin, extensions.gen_salt('bf')) where pin is not null and pin_hash is null;

do $do$
begin
  if exists (select 1 from public.users where pin is not null and (pin_hash is null or extensions.crypt(pin, pin_hash) <> pin_hash)) then
    raise exception 'pin hash verification failed - aborting';
  end if;
end
$do$;

alter table public.users alter column pin drop not null;

create or replace function public.users_hash_pin() returns trigger language plpgsql set search_path to 'public', 'extensions' as $f$
begin
  if new.pin is not null then
    new.pin_hash := extensions.crypt(new.pin, extensions.gen_salt('bf'));
    new.pin := null;
  end if;
  return new;
end;
$f$;
drop trigger if exists users_hash_pin_trg on public.users;
create trigger users_hash_pin_trg before insert or update of pin on public.users for each row execute function public.users_hash_pin();

update public.users set pin = null where pin is not null;

create or replace function public.login(p_username text, p_pin text) returns json language plpgsql security definer set search_path to 'public', 'extensions' as $f$
declare u public.users;
begin
  select * into u from public.users
    where lower(username) = lower(p_username) and pin_hash is not null and pin_hash = extensions.crypt(p_pin, pin_hash)
    limit 1;
  if u.id is null then return null; end if;
  return json_build_object(
    'id', u.id, 'name', u.name, 'role', u.role, 'title', u.title,
    'phone', u.phone, 'email', u.email, 'username', u.username,
    'onboarded', u.onboarded, 'emailSignature', u.email_signature, 'textSignoff', u.text_signoff,
    'nmls', u.nmls_number
  );
end;
$f$;

create or replace function public.change_pin(p_user_id text, p_old_pin text, p_new_pin text) returns boolean language plpgsql security definer set search_path to 'public', 'extensions' as $f$
declare me text; ok boolean;
begin
  select app_id into me from public.current_app_user() limit 1;
  if me is null or me <> p_user_id then return false; end if;
  select true into ok from public.users where id = p_user_id and pin_hash is not null and pin_hash = extensions.crypt(p_old_pin, pin_hash);
  if ok is null then return false; end if;
  update public.users set pin = p_new_pin where id = p_user_id;
  return true;
end;
$f$;

-- keep the grants from migration 102 (re-creating a function keeps its privileges, but be explicit)
revoke execute on function public.login(text, text) from public, anon;
grant execute on function public.login(text, text) to service_role;
revoke execute on function public.change_pin(text, text, text) from public, anon;
grant execute on function public.change_pin(text, text, text) to authenticated, service_role;
