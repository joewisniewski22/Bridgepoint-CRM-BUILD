-- Marketing content generated/pushed by the owner's AI command box (recent
-- closings, story posts). Tracks whether it made it to the live WordPress
-- site (wp_post_id/wp_url set once published there).
create table if not exists public.site_content (
  id text primary key,
  type text not null, -- 'closing' | 'story'
  lead_id text references public.leads(id) on delete set null,
  title text not null,
  body text not null,
  status text not null default 'draft', -- 'draft' | 'published' | 'publish_failed'
  wp_post_id bigint,
  wp_url text,
  created_by text,
  created_at timestamptz not null default now(),
  published_at timestamptz
);
alter table public.site_content enable row level security;
create policy "anon full access" on public.site_content for all to anon using (true) with check (true);

-- Conversation history for the owner-only AI command chat box.
create table if not exists public.ai_chat_messages (
  id text primary key,
  user_id text not null,
  role text not null, -- 'user' | 'assistant'
  content text not null,
  created_at timestamptz not null default now()
);
alter table public.ai_chat_messages enable row level security;
create policy "anon full access" on public.ai_chat_messages for all to anon using (true) with check (true);
