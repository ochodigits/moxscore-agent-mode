-- Atomic, service-role-only saved-deck operations.
-- Browser roles have no EXECUTE grant. The Vercel API authenticates the user,
-- supplies the owner id, and invokes these functions with the service role.

create or replace function public.moxscore_create_saved_deck(
  p_owner_id uuid,
  p_name text,
  p_format text,
  p_limit integer
)
returns public.saved_decks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved_count integer;
  created public.saved_decks;
begin
  if p_owner_id is null or char_length(btrim(coalesce(p_name, ''))) not between 1 and 200 then
    raise exception 'Invalid saved deck' using errcode = '22023';
  end if;
  if p_format <> 'commander' or p_limit not between 1 and 100 then
    raise exception 'Invalid saved deck configuration' using errcode = '22023';
  end if;

  -- Serialise creates per owner so the plan limit cannot be raced.
  perform pg_advisory_xact_lock(hashtext(p_owner_id::text));
  select count(*) into saved_count from public.saved_decks where owner_id = p_owner_id and archived_at is null;
  if saved_count >= p_limit then
    raise exception 'Saved deck limit reached' using errcode = 'P0001';
  end if;

  insert into public.saved_decks (owner_id, name, format)
  values (p_owner_id, btrim(p_name), p_format)
  returning * into created;
  return created;
end;
$$;

create or replace function public.moxscore_create_deck_version(
  p_owner_id uuid,
  p_deck_id uuid,
  p_decklist text,
  p_analysis_snapshot jsonb,
  p_analyzer_version text,
  p_curated_data_version text,
  p_limit integer
)
returns public.deck_versions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  version_count integer;
  created public.deck_versions;
begin
  if p_owner_id is null or p_deck_id is null or octet_length(coalesce(p_decklist, '')) not between 1 and 20000 then
    raise exception 'Invalid deck version' using errcode = '22023';
  end if;
  if jsonb_typeof(p_analysis_snapshot) <> 'object'
    or char_length(coalesce(p_analyzer_version, '')) not between 1 and 100
    or char_length(coalesce(p_curated_data_version, '')) not between 1 and 100
    or p_limit not between 1 and 20 then
    raise exception 'Invalid deck version configuration' using errcode = '22023';
  end if;

  -- Lock the deck row before counting versions and setting current_version_id.
  perform 1 from public.saved_decks where id = p_deck_id and owner_id = p_owner_id for update;
  if not found then
    raise exception 'Saved deck not found' using errcode = 'P0002';
  end if;

  select count(*) into version_count from public.deck_versions where deck_id = p_deck_id;
  if version_count >= p_limit then
    raise exception 'Deck version limit reached' using errcode = 'P0001';
  end if;

  insert into public.deck_versions (
    deck_id, version_number, decklist, analysis_snapshot, analyzer_version, curated_data_version
  ) values (
    p_deck_id, version_count + 1, p_decklist, p_analysis_snapshot, p_analyzer_version, p_curated_data_version
  ) returning * into created;

  update public.saved_decks set current_version_id = created.id where id = p_deck_id;
  return created;
end;
$$;

revoke all on function public.moxscore_create_saved_deck(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.moxscore_create_deck_version(uuid, uuid, text, jsonb, text, text, integer) from public, anon, authenticated;
grant execute on function public.moxscore_create_saved_deck(uuid, text, text, integer) to service_role;
grant execute on function public.moxscore_create_deck_version(uuid, uuid, text, jsonb, text, text, integer) to service_role;
