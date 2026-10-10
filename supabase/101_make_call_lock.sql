-- One dial at a time per staff member (Joe 10/10: Fiore's borrowers sometimes couldn't hear him).
-- Double/triple taps on Call rang the LO's cell 3 times at once; the extra calls arrived as
-- call-waiting, and switching to one put the borrower on hold. make-call claims this lock and
-- ignores another dial from the same person within 20 seconds.
create table if not exists public.make_call_lock (
  user_id text primary key,
  locked_at timestamptz not null default now()
);
alter table public.make_call_lock enable row level security;

create or replace function public.claim_dial(p_user text)
returns boolean language plpgsql security definer set search_path = public as $$
declare ok boolean := false;
begin
  insert into public.make_call_lock (user_id, locked_at) values (p_user, now())
  on conflict (user_id) do update set locked_at = now()
    where public.make_call_lock.locked_at < now() - interval '20 seconds'
  returning true into ok;
  return coalesce(ok, false);
end;
$$;
