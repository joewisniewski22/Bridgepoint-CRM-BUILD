-- 104: failed-login tracking for staff-login (brute-force limit). Service role only: RLS on, no policies.
create table if not exists public.login_attempts (
  id bigserial primary key,
  ip text,
  username text,
  created_at timestamptz not null default now()
);
create index if not exists login_attempts_ip_idx on public.login_attempts (ip, created_at desc);
create index if not exists login_attempts_user_idx on public.login_attempts (username, created_at desc);
alter table public.login_attempts enable row level security;
revoke all on public.login_attempts from anon, authenticated;
