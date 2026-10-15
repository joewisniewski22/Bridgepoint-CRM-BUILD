create table if not exists public.scheduled_messages (
  id uuid primary key default gen_random_uuid(),
  send_at timestamptz not null,
  channel text not null default 'sms' check (channel in ('sms','email')),
  to_phone text,
  to_email text,
  subject text,
  body text not null,
  from_name text,
  from_address text,
  status text not null default 'pending',
  attempts int not null default 0,
  error text,
  claimed_at timestamptz,
  sent_at timestamptz,
  created_by text,
  dedupe_key text,
  created_at timestamptz not null default now()
);
create index if not exists scheduled_messages_due on public.scheduled_messages (status, send_at);
alter table public.scheduled_messages enable row level security;
