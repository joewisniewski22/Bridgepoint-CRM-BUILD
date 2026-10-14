-- 115: UNBREAKABLE RULE (Joe 2026-10-14): nothing carrying another company's name or logo is ever visible to anyone but Joe, Fiore and Erika.
-- Outside-lender term sheets, sizers and quotes are only read by the CRM to pull terms; they live here, never on the loan file (leads.documents),
-- and the table + bucket are readable only by owner / lo-fiore / proc-erika at the database level.

create table if not exists public.internal_lender_docs (
  id uuid primary key default gen_random_uuid(),
  lead_id text not null,
  kind text not null default 'document',        -- document | sizer | term_sheet | option
  name text not null,
  file_name text,
  storage_path text,                              -- path inside the private bucket internal-lender-docs
  meta jsonb not null default '{}'::jsonb,        -- original details, lender names and all
  created_at timestamptz not null default now(),
  created_by text
);
create index if not exists internal_lender_docs_lead_idx on public.internal_lender_docs (lead_id);
alter table public.internal_lender_docs enable row level security;
drop policy if exists inner_circle_all on public.internal_lender_docs;
create policy inner_circle_all on public.internal_lender_docs for all to authenticated
  using (public.is_staff() and exists (select 1 from public.current_app_user() u where u.app_id in ('owner','lo-fiore','proc-erika')))
  with check (public.is_staff() and exists (select 1 from public.current_app_user() u where u.app_id in ('owner','lo-fiore','proc-erika')));
