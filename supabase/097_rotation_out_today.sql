-- Lead rotation v2 (Joe 2026-10-09):
-- 1. A lead an LO misses (the 5-minute handoff moves it) still counts against their rotation
--    share -- missing leads costs you leads. The LO who receives a handoff counts it too.
-- 2. "I'm out today": an LO who is out is skipped by the rotation and by the handoff.
-- One picker for every intake (Facebook form, website/landing pages, HighLevel, Connected
-- Investors). Counts are kept in rotation_picks, starting fresh 10/9.

alter table public.users add column if not exists out_date date;

create table if not exists public.rotation_picks (
  id bigserial primary key,
  pool text not null,              -- 'english' | 'ci'
  lo text not null,
  kind text not null default 'pick', -- 'pick' (rotation gave it to them) | 'handoff' (passed to them)
  lead_id text,
  at timestamptz not null default now()
);
alter table public.rotation_picks enable row level security;

create or replace function public.lo_out_today(p_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select out_date = (now() at time zone 'America/New_York')::date from public.users where id = p_id), false);
$$;

-- Weighted rotation: whoever is furthest below their share gets the lead. English Facebook /
-- website: Joe 30%, Fiore / Taeya / Theresa split 70%. Connected Investors / PrivateLenders:
-- Joe and Fiore 50/50. Out-today LOs are skipped; if everyone is out it's Joe's.
create or replace function public.pick_rotation_lo(p_pool text)
returns text language plpgsql security definer set search_path = public as $$
declare
  ids text[]; weights numeric[]; total numeric; best text := null; best_def numeric := null; d numeric; c numeric; i int;
begin
  perform pg_advisory_xact_lock(hashtext('rotation-' || p_pool));
  if p_pool = 'ci' then
    ids := array['owner','lo-fiore']; weights := array[0.5,0.5];
  else
    ids := array['owner','lo-fiore','lo-taeya','lo-theresa']; weights := array[0.30, 0.70/3, 0.70/3, 0.70/3];
  end if;
  select count(*) into total from public.rotation_picks where pool = p_pool;
  for i in 1..array_length(ids, 1) loop
    if public.lo_out_today(ids[i]) then continue; end if;
    select count(*) into c from public.rotation_picks where pool = p_pool and lo = ids[i];
    d := weights[i] * (total + 1) - c;
    if best_def is null or d > best_def + 0.000000001 then best := ids[i]; best_def := d; end if;
  end loop;
  if best is null then best := 'owner'; end if;
  insert into public.rotation_picks (pool, lo, kind) values (p_pool, best, 'pick');
  return best;
end;
$$;

-- Public booking links carry the lead id (&forLead=); the booking page asks who owns the lead
-- right now, so a handed-off lead books with their new LO. Returns only the LO id.
create or replace function public.booking_owner(p_lead text)
returns text language sql stable security definer set search_path = public as $$
  select assigned_to from public.leads where id = p_lead and coalesce(status, 'active') <> 'spam';
$$;
grant execute on function public.booking_owner(text) to anon, authenticated;

-- The "I'm out today" switch. Staff flip their own; the owner can flip anyone's.
create or replace function public.set_out_today(p_out boolean, p_user_id text default null)
returns date language plpgsql security definer set search_path = public as $$
declare me record; target text; d date;
begin
  select * into me from public.current_app_user() limit 1;
  if me.app_id is null then raise exception 'not signed in'; end if;
  target := coalesce(p_user_id, me.app_id);
  if target <> me.app_id and me.app_role <> 'owner' then raise exception 'not allowed'; end if;
  d := case when p_out then (now() at time zone 'America/New_York')::date else null end;
  update public.users set out_date = d where id = target;
  return d;
end;
$$;
grant execute on function public.set_out_today(boolean, text) to authenticated;

create or replace function public.list_users()
returns setof json language sql security definer set search_path = public as $$
  select json_build_object(
    'id', id, 'name', name, 'role', role, 'title', title,
    'phone', phone, 'email', email, 'username', username,
    'nmls', nmls_number, 'fullAccess', coalesce(full_access, false),
    'portalPrefs', coalesce(portal_prefs, '{}'::jsonb),
    'outToday', coalesce(out_date = (now() at time zone 'America/New_York')::date, false)
  ) from public.users;
$$;
