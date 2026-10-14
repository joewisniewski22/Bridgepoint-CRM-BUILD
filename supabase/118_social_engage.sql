-- Social engagement engine (Joe 2026-10-14: "take control of both platforms with posts and engagement" -- goal is closed deals, not followers).
create table if not exists public.social_engage_config (
  id int primary key default 1,
  enabled boolean not null default true,
  mode text not null default 'draft',          -- 'live' replies for real; 'draft' only logs what it would send
  daily_cap int not null default 40,           -- max public replies per day across both platforms
  max_per_run int not null default 8,
  updated_at timestamptz not null default now(),
  constraint social_engage_one_row check (id = 1)
);
insert into public.social_engage_config (id) values (1) on conflict (id) do nothing;
create table if not exists public.social_engagement_log (
  ext_id text primary key,                     -- "fb:<comment id>" / "ig:<comment id>"
  platform text not null,
  post_id text,
  author text,
  author_id text,
  text text,
  category text,
  action text,                                 -- reply | hide | ignore | escalate
  reply text,
  status text not null,                        -- replied | drafted | hidden | ignored | escalated | failed
  error text,
  lead_id text,
  created_at timestamptz not null default now()
);
create index if not exists social_engagement_log_created on public.social_engagement_log (created_at desc);
alter table public.social_engage_config enable row level security;
alter table public.social_engagement_log enable row level security;
-- service-role only (edge functions); no policies = no client access.
-- Comments Meta pushes to the webhook (works without the read-comments permission); social-engage drains this.
create table if not exists public.social_engagement_inbox (
  ext_id text primary key,
  platform text not null,
  post_id text,
  author text,
  author_id text,
  text text,
  created_at timestamptz not null default now()
);
alter table public.social_engagement_inbox enable row level security;
