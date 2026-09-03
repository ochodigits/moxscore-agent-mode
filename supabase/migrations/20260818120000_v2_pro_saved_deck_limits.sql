-- Allow Pro accounts to save up to 100 decks. The limit is still chosen by the
-- server from entitlement state and passed as p_limit; the function only
-- accepts the two known plan ceilings so a caller cannot invent a third.

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
  -- 10 = free Core ceiling, 100 = Pro ceiling from api/_entitlement.ts.
  if p_format <> 'commander' or p_limit not in (10, 100) then
    raise exception 'Invalid saved deck configuration' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_owner_id::text));
  select count(*) into saved_count from public.saved_decks where owner_id = p_owner_id;
  if saved_count >= p_limit then
    raise exception 'Saved deck limit reached' using errcode = 'P0001';
  end if;

  insert into public.saved_decks (owner_id, name, format)
  values (p_owner_id, btrim(p_name), p_format)
  returning * into created;
  return created;
end;
$$;
