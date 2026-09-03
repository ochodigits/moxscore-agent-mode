-- Shared deck analyses for the persistence + sharing scaffold.
-- Run in the Supabase SQL editor (or via `supabase db push`).

create table if not exists public.shared_decks (
  slug        text primary key,
  name        text,
  commander   text,
  score       integer,
  decklist    text not null,
  created_at  timestamptz not null default now()
);

create index if not exists shared_decks_created_at_idx on public.shared_decks (created_at desc);

-- RLS on. The serverless functions use the service-role key (which bypasses RLS),
-- so no insert policy is needed. A public read policy is allowed in case the
-- anon client ever queries shared decks directly.
alter table public.shared_decks enable row level security;

drop policy if exists "shared_decks public read" on public.shared_decks;
create policy "shared_decks public read"
  on public.shared_decks for select
  using (true);
