-- v2 Core correction: limits are free-product constants, including archived
-- decks. This is a new migration so shared Preview history is never rewritten.

create or replace function public.moxscore_create_saved_deck(
  p_owner_id uuid,
  p_name text,
  p_format text,
  p_limit integer
)
returns public.saved_decks
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_count integer;
  created public.saved_decks;
begin
  if p_owner_id is null or char_length(btrim(coalesce(p_name, ''))) not between 1 and 200 then
    raise exception 'Invalid saved deck' using errcode = '22023';
  end if;
  -- The API cannot select a plan or alter this fixed Core contract.
  if p_format <> 'commander' or p_limit <> 10 then
    raise exception 'Invalid saved deck configuration' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_owner_id::text));
  select count(*) into saved_count from public.saved_decks where owner_id = p_owner_id;
  if saved_count >= 10 then
    raise exception 'Saved deck limit reached' using errcode = 'P0001';
  end if;

  insert into public.saved_decks (owner_id, name, format)
  values (p_owner_id, btrim(p_name), p_format)
  returning * into created;
  return created;
end;
$$;

-- Existing functions remain service-role-only. Pin the lookup path even though
-- they are not exposed to browser roles.
alter function public.moxscore_create_deck_version(uuid, uuid, text, jsonb, text, text, integer)
  set search_path = '';
alter function public.moxscore_replace_collection(uuid, text, jsonb, jsonb)
  set search_path = '';
