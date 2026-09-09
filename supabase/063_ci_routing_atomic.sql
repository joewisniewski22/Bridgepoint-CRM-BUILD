-- Fixes a real race condition in connected-investors-webhook's 50/50
-- owner/Fiore alternation: it inferred "who's next" by querying the most
-- recent Connected Investors lead and flipping from there. When
-- HighLevel fires the webhook twice in quick succession for the same
-- contact (a known workflow re-trigger quirk, confirmed live -- "Andy
-- Vento" and "Leonard Mukiawah" each created two lead records seconds
-- apart), both requests can read the same "last" lead before either
-- insert commits, so both compute the same next assignee -- breaking
-- the alternation and sometimes routing a duplicate to the wrong person.
-- A single-row atomic UPDATE...RETURNING is serialized by Postgres's own
-- row lock, so concurrent requests can no longer race each other.
create table if not exists public.ci_routing_state (
  id int primary key default 1,
  last_assigned text not null default 'lo-fiore',
  constraint ci_routing_state_single_row check (id = 1)
);
insert into public.ci_routing_state (id, last_assigned)
  values (1, 'lo-fiore')
  on conflict (id) do nothing;

alter table public.ci_routing_state enable row level security;
create policy "service role only" on public.ci_routing_state for all to service_role using (true) with check (true);

create or replace function public.next_ci_assignee()
returns text
language sql
security definer
set search_path = public
as $$
  update public.ci_routing_state
  set last_assigned = case when last_assigned = 'owner' then 'lo-fiore' else 'owner' end
  where id = 1
  returning last_assigned;
$$;
grant execute on function public.next_ci_assignee() to service_role;
