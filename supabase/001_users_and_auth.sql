-- Bridgepoint Lending Desk — Stage 1: users + login
-- Run this whole script once in the Supabase SQL Editor.

create table public.users (
  id text primary key,
  name text not null,
  role text not null check (role in ('owner','loan_officer','processor')),
  title text,
  phone text,
  email text,
  username text unique not null,
  pin text not null,
  onboarded boolean not null default false,
  email_signature text,
  text_signoff text
);

-- Lock the table down completely. The only way in or out is through the
-- SECURITY DEFINER functions below, so PINs are never directly readable
-- by the app's public (anon) key.
alter table public.users enable row level security;

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
    'onboarded', u.onboarded, 'emailSignature', u.email_signature, 'textSignoff', u.text_signoff
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
    'phone', phone, 'email', email, 'username', username
  ) from public.users;
$$;
grant execute on function public.list_users() to anon;

create or replace function public.save_signature(p_user_id text, p_email_signature text, p_text_signoff text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.users
    set email_signature = p_email_signature, text_signoff = p_text_signoff, onboarded = true
    where id = p_user_id;
$$;
grant execute on function public.save_signature(text, text, text) to anon;

create or replace function public.change_pin(p_user_id text, p_old_pin text, p_new_pin text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare ok boolean;
begin
  select true into ok from public.users where id = p_user_id and pin = p_old_pin;
  if ok is null then return false; end if;
  update public.users set pin = p_new_pin where id = p_user_id;
  return true;
end;
$$;
grant execute on function public.change_pin(text, text, text) to anon;

create or replace function public.reset_pin(p_user_id text, p_new_pin text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.users set pin = p_new_pin where id = p_user_id;
$$;
grant execute on function public.reset_pin(text, text) to anon;

-- Seed the same team that's in the demo today. Change PINs later from
-- inside the app (Team tab, or each person's own Change PIN button).
insert into public.users (id, name, role, title, phone, email, username, pin, onboarded) values
('owner',     'Joe',           'owner',         'Owner / Principal',    '(813) 555-0100', 'joe@bplending.com',    'joe',   '1010', true),
('lo-maria',  'Maria Delgado', 'loan_officer',  'Senior Loan Officer',  '(813) 555-0142', 'maria@bplending.com',  'maria', '2020', false),
('lo-devon',  'Devon Marsh',   'loan_officer',  'Loan Officer',         '(813) 555-0158', 'devon@bplending.com',  'devon', '2030', false),
('lo-priya',  'Priya Anand',   'loan_officer',  'Loan Officer',         '(813) 555-0163', 'priya@bplending.com',  'priya', '2040', false),
('lo-blake',  'Blake Ferro',   'loan_officer',  'Loan Officer',         '(813) 555-0171', 'blake@bplending.com',  'blake', '2050', false),
('lo-nina',   'Nina Osei',     'loan_officer',  'Loan Officer',         '(813) 555-0186', 'nina@bplending.com',   'nina',  '2060', false),
('proc-erika','Erika',         'processor',     'Loan Processor',      '(813) 555-0199', 'Erika@bplending.com',  'erika', '3030', false);
