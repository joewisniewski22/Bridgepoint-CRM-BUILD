-- Joe's ask (2026-09-26): ask an LO to pick between two real options (e.g.
-- Constructive in-house vs. a real RCN term sheet) by text/email, and have
-- whichever one they reply with auto-applied to the file -- "if she
-- responds in email or text auto apply what she choses". Stores the exact
-- field patch each option would apply so the webhooks below never have to
-- guess/recompute pricing themselves, just match a reply to one of these
-- pre-computed choices.
alter table public.leads add column if not exists pending_decision jsonb;
