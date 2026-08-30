-- Optional profile photo for email signatures.
alter table public.users add column photo_url text;

create or replace function public.login(p_username text, p_pin text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  u public.users;
begin
  select * into u from public.users
    where lower(username) = lower(p_username) and pin = p_pin
    limit 1;
  if u.id is null then
    return null;
  end if;
  return json_build_object(
    'id', u.id, 'name', u.name, 'role', u.role, 'title', u.title,
    'phone', u.phone, 'email', u.email, 'username', u.username,
    'onboarded', u.onboarded, 'emailSignature', u.email_signature, 'textSignoff', u.text_signoff,
    'quoPhoneNumber', u.quo_phone_number, 'photoUrl', u.photo_url
  );
end;
$$;
grant execute on function public.login(text, text) to anon;

create or replace function public.list_users()
returns setof json
language sql
security definer
set search_path = public
as $$
  select json_build_object(
    'id', id, 'name', name, 'role', role, 'title', title,
    'phone', phone, 'email', email, 'username', username,
    'quoPhoneNumber', quo_phone_number, 'photoUrl', photo_url
  ) from public.users;
$$;
grant execute on function public.list_users() to anon;

create or replace function public.set_photo_url(p_user_id text, p_photo_url text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.users set photo_url = p_photo_url where id = p_user_id;
$$;
grant execute on function public.set_photo_url(text, text) to anon;
