-- Landing-page funnel + submit outcomes (2026-10-08). Written only by the public
-- ad-lead-intake function (service role): one row per quiz step reached and per
-- submit (created / repeat / invalid / honeypot / error). No PII stored.
create table if not exists public.ad_intake_log (
  id bigserial primary key,
  ts timestamptz not null default now(),
  kind text not null,          -- step | submit
  step int,
  outcome text,
  status int,
  program text,
  session text,
  utm_campaign text,
  utm_content text,
  src text
);
create index if not exists ad_intake_log_ts_idx on public.ad_intake_log(ts);
alter table public.ad_intake_log enable row level security;
