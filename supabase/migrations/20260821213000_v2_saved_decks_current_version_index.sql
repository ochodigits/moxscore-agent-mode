-- Postgres does not automatically index foreign-key columns. This partial
-- index keeps deck-version deletion / ON DELETE SET NULL from scanning every
-- saved deck while omitting rows that have no current version.

create index if not exists saved_decks_current_version_idx
  on public.saved_decks (current_version_id)
  where current_version_id is not null;
