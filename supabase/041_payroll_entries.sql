-- Paid/outstanding payroll ledger. Covers both real closed loans in this
-- CRM (lead_id set, "Mark Paid" from the Payroll page inserts a 'paid' row
-- here) and historical/manual entries from before this CRM existed
-- (lead_id null, file_label used instead -- e.g. loans entered in Joe's
-- old system that have no corresponding lead record here).
create table if not exists public.payroll_entries (
  id text primary key,
  lead_id text references public.leads(id) on delete set null,
  person_id text not null,
  role text not null, -- 'lo' | 'processor'
  file_label text, -- used when lead_id is null
  amount numeric not null,
  status text not null default 'outstanding', -- 'outstanding' | 'paid'
  note text,
  entry_date date not null default current_date,
  created_by text,
  created_at timestamptz not null default now()
);
alter table public.payroll_entries enable row level security;
create policy "anon full access" on public.payroll_entries for all to anon using (true) with check (true);
