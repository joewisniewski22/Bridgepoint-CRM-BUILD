-- 111 (10/12/2026, Joe): a loan officer can answer a client by replying to the alert text on their phone.
-- Each client-text alert we send an LO is remembered here for 2 hours so receive-text knows which client a reply is for.
create table if not exists public.staff_reply_context (
  id bigserial primary key,
  staff_id text not null,
  lead_id text not null,
  lead_name text,
  created_at timestamptz not null default now()
);
create index if not exists staff_reply_context_staff_idx on public.staff_reply_context (staff_id, created_at desc);
alter table public.staff_reply_context enable row level security;
revoke all on public.staff_reply_context from anon, authenticated;
