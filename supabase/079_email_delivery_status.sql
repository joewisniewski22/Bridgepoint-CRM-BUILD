-- Tracks the real delivery chain per email (Sent -> Delivered -> Opened,
-- or Bounced), fed by Postmark's webhook -- not just "the API accepted it,"
-- which is all send-email's own response can ever confirm.
alter table public.emails add column if not exists delivery_status text default 'sent';
alter table public.emails add column if not exists delivered_at timestamptz;
alter table public.emails add column if not exists bounced_at timestamptz;
alter table public.emails add column if not exists bounce_reason text;
