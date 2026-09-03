-- V2 optional identity and saved-deck foundation.
--
-- Every table is protected by RLS, every browser-visible role receives only
-- the least privileges it needs, and plan/quota decisions remain server-side.
-- This migration intentionally does not modify the anonymous v1 share tables.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  locale text not null default 'en' check (char_length(locale) between 2 and 20),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deletion_requested_at timestamptz
);

create table if not exists public.saved_decks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  format text not null default 'commander' check (format = 'commander'),
  current_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create index if not exists saved_decks_owner_updated_idx
  on public.saved_decks (owner_id, updated_at desc);

create table if not exists public.deck_versions (
  id uuid primary key default gen_random_uuid(),
  deck_id uuid not null references public.saved_decks(id) on delete cascade,
  version_number integer not null check (version_number > 0 and version_number <= 20),
  decklist text not null check (octet_length(decklist) between 1 and 20000),
  analysis_snapshot jsonb not null check (jsonb_typeof(analysis_snapshot) = 'object'),
  analyzer_version text not null check (char_length(analyzer_version) between 1 and 100),
  curated_data_version text not null check (char_length(curated_data_version) between 1 and 100),
  created_at timestamptz not null default now(),
  unique (deck_id, version_number)
);

create index if not exists deck_versions_deck_number_idx
  on public.deck_versions (deck_id, version_number desc);

alter table public.saved_decks
  drop constraint if exists saved_decks_current_version_id_fkey;
alter table public.saved_decks
  add constraint saved_decks_current_version_id_fkey
  foreign key (current_version_id) references public.deck_versions(id) on delete set null;

-- Timestamps are server-maintained and the trigger function has no RPC-safe
-- return type. It executes as the calling table owner when the trigger runs.
create or replace function public.moxscore_set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.moxscore_set_updated_at();

drop trigger if exists saved_decks_set_updated_at on public.saved_decks;
create trigger saved_decks_set_updated_at
  before update on public.saved_decks
  for each row execute function public.moxscore_set_updated_at();

alter table public.profiles enable row level security;
alter table public.saved_decks enable row level security;
alter table public.deck_versions enable row level security;

-- Public-schema tables are not granted to anonymous visitors. Authenticated
-- callers receive only the direct profile fields needed by the account UI.
-- Deck writes go through server-only APIs so plan limits are not bypassable.
revoke all privileges on table public.profiles from public, anon, authenticated;
revoke all privileges on table public.saved_decks from public, anon, authenticated;
revoke all privileges on table public.deck_versions from public, anon, authenticated;

grant select (id, display_name, locale, created_at, updated_at, deletion_requested_at)
  on public.profiles to authenticated;
grant insert (id, display_name, locale) on public.profiles to authenticated;
grant update (display_name, locale) on public.profiles to authenticated;

grant select on public.saved_decks to authenticated;

grant select on public.deck_versions to authenticated;

drop policy if exists "profiles are owner readable" on public.profiles;
create policy "profiles are owner readable"
  on public.profiles for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = id);

drop policy if exists "profiles are owner creatable" on public.profiles;
create policy "profiles are owner creatable"
  on public.profiles for insert to authenticated
  with check ((select auth.uid()) is not null and (select auth.uid()) = id);

drop policy if exists "profiles are owner updatable" on public.profiles;
create policy "profiles are owner updatable"
  on public.profiles for update to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = id)
  with check ((select auth.uid()) is not null and (select auth.uid()) = id);

drop policy if exists "saved decks are owner readable" on public.saved_decks;
create policy "saved decks are owner readable"
  on public.saved_decks for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = owner_id);

drop policy if exists "saved decks are owner creatable" on public.saved_decks;
create policy "saved decks are owner creatable"
  on public.saved_decks for insert to authenticated
  with check ((select auth.uid()) is not null and (select auth.uid()) = owner_id);

drop policy if exists "saved decks are owner updatable" on public.saved_decks;
create policy "saved decks are owner updatable"
  on public.saved_decks for update to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = owner_id)
  with check ((select auth.uid()) is not null and (select auth.uid()) = owner_id);

drop policy if exists "saved decks are owner deletable" on public.saved_decks;
create policy "saved decks are owner deletable"
  on public.saved_decks for delete to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = owner_id);

drop policy if exists "deck versions are owner readable" on public.deck_versions;
create policy "deck versions are owner readable"
  on public.deck_versions for select to authenticated
  using (
    exists (
      select 1 from public.saved_decks
      where saved_decks.id = deck_versions.deck_id
        and saved_decks.owner_id = (select auth.uid())
    )
  );

-- The service role executes all deck writes only after API identity,
-- ownership, plan-limit, and immutable-version checks. It bypasses RLS but is
-- never shipped to the browser.
revoke all privileges on table public.profiles from service_role;
revoke all privileges on table public.saved_decks from service_role;
revoke all privileges on table public.deck_versions from service_role;
grant select, insert, update, delete on public.profiles to service_role;
grant select, insert, update, delete on public.saved_decks to service_role;
grant select, insert, update, delete on public.deck_versions to service_role;
