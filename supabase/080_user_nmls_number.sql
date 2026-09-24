-- MISMO 3.4 exports need a LICENSE_DETAIL/LicenseIdentifier for the
-- LoanOriginator party, and the CRM had nowhere to store each person's
-- individual NMLS/license number -- found 2026-09-24 building the MISMO
-- export feature (Joe's ask: "make sure our system has and asks for all
-- that the lender might need").
alter table public.users add column if not exists nmls_number text;

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
    'nmls', u.nmls_number
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
    'nmls', nmls_number
  ) from public.users;
$$;
grant execute on function public.list_users() to anon;

-- Postgres treats a new parameter list as a distinct overload even with a
-- default -- drop the old 3-arg signature first so RPC calls with exactly
-- 3 named args (every existing caller) still resolve to this one function.
drop function if exists public.save_signature(text, text, text);

create or replace function public.save_signature(p_user_id text, p_email_signature text, p_text_signoff text, p_nmls text default null)
returns void
language sql
security definer
set search_path = public
as $$
  update public.users
    set email_signature = p_email_signature, text_signoff = p_text_signoff, onboarded = true,
      nmls_number = coalesce(p_nmls, nmls_number)
    where id = p_user_id;
$$;
grant execute on function public.save_signature(text, text, text, text) to anon;
