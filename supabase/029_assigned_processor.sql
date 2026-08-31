-- Tracks which processor owns a given file, so files auto-balance across
-- processors as more are hired, and processing to-dos/notifications only
-- reach the one processor actually working that file (not every processor).
alter table public.leads add column if not exists assigned_processor text;
