-- Postmark open tracking: send-email now passes TrackOpens: true, and the
-- new postmark-open-webhook function writes here when a recipient actually
-- opens an email (open_count increments on every open, opened_at is only
-- ever the FIRST open so "when did they open it" stays meaningful).
alter table public.emails add column if not exists opened_at timestamptz;
alter table public.emails add column if not exists open_count integer default 0;
