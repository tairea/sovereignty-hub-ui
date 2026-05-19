-- Sovereignty Hub — initial schema
-- Paste into Supabase Dashboard → SQL Editor → New query → Run.
-- Idempotent: safe to re-run.

-- =====================================================================
-- profiles
-- =====================================================================
create table if not exists public.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  hub_name        text,
  hub_email       text,
  hub_link        text,
  hub_image_url   text,
  updated_at      timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- SELECT is public so the network view can show every hub in the directory.
-- Writes stay own-row only. Wrap auth.uid() in (select ...) so Postgres
-- evaluates it once per query, not once per row (db-linter auth_rls_initplan).
drop policy if exists "profiles_select_own" on public.profiles;
drop policy if exists "profiles_select_public" on public.profiles;
create policy "profiles_select_public"
  on public.profiles for select
  using (true);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles for insert
  with check ((select auth.uid()) = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- =====================================================================
-- survey_state — one row per user, mirrors the client's localStorage shape
-- =====================================================================
create table if not exists public.survey_state (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  answers       jsonb not null default '{}'::jsonb,
  descriptions  jsonb not null default '{}'::jsonb,
  cursor        int   not null default 0,
  max_reached   int   not null default 0,
  updated_at    timestamptz not null default now()
);

alter table public.survey_state enable row level security;

drop policy if exists "survey_state_select_own" on public.survey_state;
drop policy if exists "survey_state_select_public" on public.survey_state;
create policy "survey_state_select_public"
  on public.survey_state for select
  using (true);

drop policy if exists "survey_state_insert_own" on public.survey_state;
create policy "survey_state_insert_own"
  on public.survey_state for insert
  with check ((select auth.uid()) = user_id);

drop policy if exists "survey_state_update_own" on public.survey_state;
create policy "survey_state_update_own"
  on public.survey_state for update
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- =====================================================================
-- Auto-create profile + survey_state rows on signup
-- =====================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id)
    on conflict (id) do nothing;
  insert into public.survey_state (user_id) values (new.id)
    on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Function is invoked only by the trigger above (which runs as the table
-- owner regardless of caller). Block direct execution by API roles so the
-- SECURITY DEFINER privilege can't be reached from PostgREST.
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- =====================================================================
-- Storage: hub-avatars bucket (public read; owner-only write)
-- =====================================================================
insert into storage.buckets (id, name, public)
  values ('hub-avatars', 'hub-avatars', true)
  on conflict (id) do update set public = true;

-- Files are uploaded under "<user_id>/<filename>" so the first folder
-- segment matches auth.uid().
drop policy if exists "hub_avatars_public_read" on storage.objects;
create policy "hub_avatars_public_read"
  on storage.objects for select
  using (bucket_id = 'hub-avatars');

drop policy if exists "hub_avatars_owner_insert" on storage.objects;
create policy "hub_avatars_owner_insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'hub-avatars'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

drop policy if exists "hub_avatars_owner_update" on storage.objects;
create policy "hub_avatars_owner_update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'hub-avatars'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  )
  with check (
    bucket_id = 'hub-avatars'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

drop policy if exists "hub_avatars_owner_delete" on storage.objects;
create policy "hub_avatars_owner_delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'hub-avatars'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

-- =====================================================================
-- layer_chats — per-(hub × pillar × layer) chat thread
-- Anyone can read; signed-in users can post their own; authors can
-- edit/delete their own messages.
-- =====================================================================
create table if not exists public.layer_chats (
  id            uuid primary key default gen_random_uuid(),
  hub_owner_id  uuid not null references auth.users(id) on delete cascade,
  pillar_idx    smallint not null check (pillar_idx between 0 and 12),
  layer_idx     smallint not null check (layer_idx between 0 and 6),
  author_id     uuid not null references auth.users(id) on delete cascade,
  body          text not null check (char_length(body) between 1 and 2000),
  created_at    timestamptz not null default now()
);

create index if not exists layer_chats_lookup
  on public.layer_chats (hub_owner_id, pillar_idx, layer_idx, created_at);

alter table public.layer_chats enable row level security;

drop policy if exists "layer_chats_select_public" on public.layer_chats;
create policy "layer_chats_select_public"
  on public.layer_chats for select
  using (true);

drop policy if exists "layer_chats_insert_own" on public.layer_chats;
create policy "layer_chats_insert_own"
  on public.layer_chats for insert
  with check ((select auth.uid()) = author_id);

drop policy if exists "layer_chats_update_own" on public.layer_chats;
create policy "layer_chats_update_own"
  on public.layer_chats for update
  using ((select auth.uid()) = author_id)
  with check ((select auth.uid()) = author_id);

drop policy if exists "layer_chats_delete_own" on public.layer_chats;
create policy "layer_chats_delete_own"
  on public.layer_chats for delete
  using ((select auth.uid()) = author_id);
