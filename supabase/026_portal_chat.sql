-- Two-way borrower portal chat: the borrower's portal messages and the
-- loan officer's SMS replies (routed back in via the receive-text webhook)
-- both live in this one thread per lead.
alter table public.leads add column if not exists portal_chat jsonb default '[]'::jsonb;
