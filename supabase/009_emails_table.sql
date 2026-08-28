create table public.emails (
  id text primary key,
  lead_id text references public.leads(id),
  direction text not null check (direction in ('outbound','inbound')),
  from_address text not null,
  to_address text not null,
  subject text,
  body text,
  sent_by text references public.users(id),
  postmark_message_id text,
  created_at timestamptz not null default now()
);

alter table public.emails enable row level security;
create policy "anon full access" on public.emails for all to anon using (true) with check (true);
grant select, insert, update, delete on public.emails to anon;
