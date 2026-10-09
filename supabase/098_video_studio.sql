-- Video Studio (Joe 2026-10-09): LOs record short social videos -- Taeya English, Fanis Spanish,
-- Theresa Vietnamese. Each gets their scripts (with what to wear and where to shoot) in the CRM
-- at ?studio=1 and uploads the takes from their phone. Joe sees every upload.

create table if not exists public.video_scripts (
  id text primary key,
  user_id text not null,
  lang text not null,          -- en | es | vi
  sort int not null default 0,
  title text not null,
  hook text,                   -- the first line, said in the first 2 seconds
  script text not null,
  wardrobe text,
  location text,
  shot_notes text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.video_scripts enable row level security;
drop policy if exists "staff read own scripts" on public.video_scripts;
create policy "staff read own scripts" on public.video_scripts for select to authenticated using (
  exists (select 1 from public.current_app_user() u where u.app_role = 'owner' or u.app_id = video_scripts.user_id)
);

create table if not exists public.social_videos (
  id uuid primary key default gen_random_uuid(),
  script_id text,
  user_id text not null,
  path text not null,
  size_bytes bigint,
  status text not null default 'uploaded', -- uploaded | approved | posted | redo
  note text,
  created_at timestamptz not null default now()
);
alter table public.social_videos enable row level security;
drop policy if exists "staff insert own videos" on public.social_videos;
create policy "staff insert own videos" on public.social_videos for insert to authenticated with check (
  exists (select 1 from public.current_app_user() u where u.app_id = social_videos.user_id)
);
drop policy if exists "staff read own videos" on public.social_videos;
create policy "staff read own videos" on public.social_videos for select to authenticated using (
  exists (select 1 from public.current_app_user() u where u.app_role = 'owner' or u.app_id = social_videos.user_id)
);
drop policy if exists "owner updates videos" on public.social_videos;
create policy "owner updates videos" on public.social_videos for update to authenticated using (
  exists (select 1 from public.current_app_user() u where u.app_role = 'owner')
);

-- Private bucket; each person uploads only into their own folder (<user id>/...).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('social-videos', 'social-videos', false, 524288000, array['video/mp4','video/quicktime','video/x-m4v','video/webm','video/3gpp','video/hevc'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "social videos upload own folder" on storage.objects;
create policy "social videos upload own folder" on storage.objects for insert to authenticated with check (
  bucket_id = 'social-videos' and exists (select 1 from public.current_app_user() u where u.app_id = (storage.foldername(name))[1])
);
drop policy if exists "social videos read own or owner" on storage.objects;
create policy "social videos read own or owner" on storage.objects for select to authenticated using (
  bucket_id = 'social-videos' and exists (select 1 from public.current_app_user() u where u.app_role = 'owner' or u.app_id = (storage.foldername(name))[1])
);
