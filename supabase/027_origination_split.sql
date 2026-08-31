-- Per-employee origination (points) commission split on company-provided
-- leads. Defaults to 50% for everyone; some employees (e.g. a VP of
-- Lending) negotiate a different split. Self-generated business and yield
-- spread commission use their own fixed global rules in the app code, not
-- this per-user override -- this column only covers the "company lead"
-- default split.
alter table public.users add column if not exists origination_split numeric default 0.5;

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
    'originationSplit', coalesce(u.origination_split, 0.5)
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
    'originationSplit', coalesce(origination_split, 0.5)
  ) from public.users;
$$;
grant execute on function public.list_users() to anon;

create or replace function public.create_user(
  p_name text, p_role text, p_title text, p_phone text, p_email text, p_username text, p_pin text,
  p_quo_phone_number text default null, p_origination_split numeric default 0.5
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id text;
  existing int;
begin
  if p_role not in ('loan_officer','processor') then
    raise exception 'invalid_role';
  end if;
  select count(*) into existing from public.users where lower(username) = lower(p_username);
  if existing > 0 then
    raise exception 'username_taken';
  end if;
  new_id := (case when p_role = 'processor' then 'proc-' else 'lo-' end) || lower(regexp_replace(p_username, '[^a-zA-Z0-9]', '', 'g'));
  insert into public.users (id, name, role, title, phone, email, username, pin, onboarded, quo_phone_number, origination_split)
    values (new_id, p_name, p_role, p_title, p_phone, p_email, lower(p_username), p_pin, false, p_quo_phone_number, coalesce(p_origination_split, 0.5));
  return json_build_object(
    'id', new_id, 'name', p_name, 'role', p_role, 'title', p_title,
    'phone', p_phone, 'email', p_email, 'username', lower(p_username), 'onboarded', false,
    'quoPhoneNumber', p_quo_phone_number, 'originationSplit', coalesce(p_origination_split, 0.5)
  );
end;
$$;
grant execute on function public.create_user(text, text, text, text, text, text, text, text, numeric) to anon;

create or replace function public.set_origination_split(p_user_id text, p_split numeric)
returns void
language sql
security definer
set search_path = public
as $$
  update public.users set origination_split = p_split where id = p_user_id;
$$;
grant execute on function public.set_origination_split(text, numeric) to anon;
