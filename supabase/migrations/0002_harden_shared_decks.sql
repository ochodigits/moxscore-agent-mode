-- Tier 0 hardening for shared_decks.
-- Run in the Supabase SQL editor (or via `supabase db push`).

-- Defense in depth: cap decklist size at the database layer too (the API
-- already returns 413 above 20 KB).
alter table public.shared_decks
  drop constraint if exists shared_decks_decklist_len;
alter table public.shared_decks
  add constraint shared_decks_decklist_len check (length(decklist) <= 20000);

alter table public.shared_decks
  drop constraint if exists shared_decks_score_range;
alter table public.shared_decks
  add constraint shared_decks_score_range check (score is null or (score >= 0 and score <= 100));

-- Persist the scoring format so shared links restore the same analysis.
alter table public.shared_decks
  add column if not exists format text;

-- Share-link obscurity: slugs are unguessable capability URLs, so anyone
-- holding the (public) anon key must not be able to dump the table via
-- PostgREST. All legitimate reads go through the serverless functions, which
-- use the service-role key.
drop policy if exists "shared_decks public read" on public.shared_decks;
