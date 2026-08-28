create or replace function public.create_user(
  p_name text, p_role text, p_title text, p_phone text, p_email text, p_username text, p_pin text
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
  insert into public.users (id, name, role, title, phone, email, username, pin, onboarded)
    values (new_id, p_name, p_role, p_title, p_phone, p_email, lower(p_username), p_pin, false);
  return json_build_object(
    'id', new_id, 'name', p_name, 'role', p_role, 'title', p_title,
    'phone', p_phone, 'email', p_email, 'username', lower(p_username), 'onboarded', false
  );
end;
$$;
grant execute on function public.create_user(text, text, text, text, text, text, text) to anon;
