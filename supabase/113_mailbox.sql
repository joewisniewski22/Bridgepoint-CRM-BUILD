-- 113: a real mailbox in the CRM (Joe 2026-10-13: "a legitimate inbox/outbox/mailbox system where we can send/receive/store", Outlook-like).
-- Adds folders, read/flag state, drafts, cc/bcc, attachments, threads and per-person privacy to public.emails, which until now was a
-- send log (1,492 sent, 4 received). Columns for a later Microsoft 365 (Graph) sync are included (source, graph_id, graph_conversation_id).

alter table public.emails
  add column if not exists mailbox_user_id text,
  add column if not exists folder text,
  add column if not exists is_read boolean not null default true,
  add column if not exists is_flagged boolean not null default false,
  add column if not exists cc_address text,
  add column if not exists bcc_address text,
  add column if not exists thread_key text,
  add column if not exists attachments jsonb not null default '[]'::jsonb,
  add column if not exists html_body text,
  add column if not exists source text not null default 'postmark',
  add column if not exists graph_id text,
  add column if not exists graph_conversation_id text,
  add column if not exists automated boolean not null default false,
  add column if not exists deleted_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

-- Existing rows: whose mailbox, which folder, which conversation.
-- Mail sent by the system on someone's behalf (AI follow-ups, campaigns: sent_by is null) goes to "automated" so it doesn't bury real mail.
update public.emails e
set mailbox_user_id = coalesce(e.sent_by, (select l.assigned_to from public.leads l where l.id = e.lead_id)),
    automated = (e.direction = 'outbound' and e.sent_by is null),
    folder = case when e.direction = 'inbound' then 'inbox'
                  when e.sent_by is null then 'automated'
                  else 'sent' end
where e.folder is null;

update public.emails
set thread_key = lower(regexp_replace(coalesce(subject, ''), '^\s*((re|fw|fwd)\s*:\s*)+', '', 'i')) || '|' ||
                 coalesce(lead_id, lower(case when direction = 'inbound' then from_address else to_address end), '')
where thread_key is null;

alter table public.emails alter column folder set default 'inbox';

create index if not exists emails_mailbox_folder_idx on public.emails (mailbox_user_id, folder, created_at desc);
create index if not exists emails_thread_idx on public.emails (thread_key);
create unique index if not exists emails_graph_id_idx on public.emails (graph_id) where graph_id is not null;

-- Privacy: until now every signed-in staff member could read every email. Now: your own mailbox, plus mail on a loan file you can already see
-- (the leads table's own scoping decides that). Only the mailbox owner (or the owner role) can change or delete a message.
drop policy if exists "authenticated full access" on public.emails;
drop policy if exists emails_select on public.emails;
drop policy if exists emails_insert on public.emails;
drop policy if exists emails_update on public.emails;
drop policy if exists emails_delete on public.emails;

create policy emails_select on public.emails for select to authenticated using (
  public.is_staff() and (
    mailbox_user_id = (select u.app_id from public.current_app_user() u limit 1)
    or (lead_id is not null and exists (select 1 from public.leads l where l.id = emails.lead_id))
  )
);
create policy emails_insert on public.emails for insert to authenticated with check (
  public.is_staff() and mailbox_user_id = (select u.app_id from public.current_app_user() u limit 1)
);
create policy emails_update on public.emails for update to authenticated using (
  public.is_staff() and (
    mailbox_user_id = (select u.app_id from public.current_app_user() u limit 1)
    or exists (select 1 from public.current_app_user() u where u.app_role = 'owner')
  )
) with check (
  public.is_staff() and (
    mailbox_user_id = (select u.app_id from public.current_app_user() u limit 1)
    or exists (select 1 from public.current_app_user() u where u.app_role = 'owner')
  )
);
create policy emails_delete on public.emails for delete to authenticated using (
  public.is_staff() and (
    mailbox_user_id = (select u.app_id from public.current_app_user() u limit 1)
    or exists (select 1 from public.current_app_user() u where u.app_role = 'owner')
  )
);

-- Attachments live in a private bucket; signed-in staff only (files are opened through short-lived signed links).
insert into storage.buckets (id, name, public) values ('mail-attachments', 'mail-attachments', false) on conflict (id) do nothing;
drop policy if exists "staff read mail-attachments" on storage.objects;
drop policy if exists "staff write mail-attachments" on storage.objects;
create policy "staff read mail-attachments" on storage.objects for select to authenticated using (bucket_id = 'mail-attachments' and public.is_staff());
create policy "staff write mail-attachments" on storage.objects for insert to authenticated with check (bucket_id = 'mail-attachments' and public.is_staff());
