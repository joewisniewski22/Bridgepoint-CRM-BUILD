-- Tracks which staff members speak Spanish, for lead-routing rules (route
-- a Spanish-speaking borrower to a Spanish-speaking LO automatically).
alter table public.users add column if not exists speaks_spanish boolean default false;

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
    'quoPhoneNumber', u.quo_phone_number, 'photoUrl', u.photo_url,
    'originationSplit', coalesce(u.origination_split, 0.5), 'speaksSpanish', coalesce(u.speaks_spanish, false)
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
    'quoPhoneNumber', quo_phone_number, 'photoUrl', photo_url,
    'originationSplit', coalesce(origination_split, 0.5), 'speaksSpanish', coalesce(speaks_spanish, false)
  ) from public.users;
$$;
grant execute on function public.list_users() to anon;

create or replace function public.set_speaks_spanish(p_user_id text, p_value boolean)
returns void
language sql
security definer
set search_path = public
as $$
  update public.users set speaks_spanish = p_value where id = p_user_id;
$$;
grant execute on function public.set_speaks_spanish(text, boolean) to anon;
