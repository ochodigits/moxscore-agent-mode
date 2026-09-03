-- One normalized collection per account. Raw import files are parsed locally
-- and never stored; only normalized rows and a minimal summary are persisted.

create table if not exists public.collections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users(id) on delete cascade,
  source_type text not null check (source_type in ('manabox-csv', 'generic-csv', 'text')),
  import_summary jsonb not null default '{}'::jsonb check (jsonb_typeof(import_summary) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.collection_cards (
  collection_id uuid not null references public.collections(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  normalized_name text not null check (char_length(normalized_name) between 1 and 200),
  scryfall_oracle_id uuid,
  quantity integer not null check (quantity between 1 and 1000),
  unresolved boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (collection_id, normalized_name)
);

create index if not exists collection_cards_name_idx on public.collection_cards (normalized_name);

drop trigger if exists collections_set_updated_at on public.collections;
create trigger collections_set_updated_at
  before update on public.collections
  for each row execute function public.moxscore_set_updated_at();

alter table public.collections enable row level security;
alter table public.collection_cards enable row level security;
revoke all privileges on table public.collections from public, anon, authenticated;
revoke all privileges on table public.collection_cards from public, anon, authenticated;

-- Browser clients never write collections directly: server code enforces
-- capabilities and uses a transaction to replace the normalized rows.
grant select on public.collections to authenticated;
grant select on public.collection_cards to authenticated;

drop policy if exists "collections are owner readable" on public.collections;
create policy "collections are owner readable"
  on public.collections for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = owner_id);

drop policy if exists "collection cards are owner readable" on public.collection_cards;
create policy "collection cards are owner readable"
  on public.collection_cards for select to authenticated
  using (
    exists (
      select 1 from public.collections
      where collections.id = collection_cards.collection_id
        and collections.owner_id = (select auth.uid())
    )
  );

create or replace function public.moxscore_replace_collection(
  p_owner_id uuid,
  p_source_type text,
  p_cards jsonb,
  p_import_summary jsonb
)
returns public.collections
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  collection_row public.collections;
  card_count integer;
begin
  if p_owner_id is null
    or coalesce(p_source_type, '') not in ('manabox-csv', 'generic-csv', 'text')
    or coalesce(jsonb_typeof(p_cards), '') <> 'array'
    or coalesce(jsonb_typeof(p_import_summary), '') <> 'object'
    or jsonb_array_length(p_cards) > 10000 then
    raise exception 'Invalid collection' using errcode = '22023';
  end if;

  select count(*) into card_count
  from jsonb_to_recordset(p_cards) as card(name text, quantity integer, unresolved boolean)
  where char_length(btrim(coalesce(card.name, ''))) between 1 and 200
    and card.quantity between 1 and 1000;
  if card_count <> jsonb_array_length(p_cards) then
    raise exception 'Invalid collection card' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_owner_id::text));
  select * into collection_row from public.collections where owner_id = p_owner_id for update;
  if not found then
    insert into public.collections (owner_id, source_type, import_summary)
    values (p_owner_id, p_source_type, p_import_summary)
    returning * into collection_row;
  else
    update public.collections
      set source_type = p_source_type, import_summary = p_import_summary
      where id = collection_row.id
      returning * into collection_row;
    delete from public.collection_cards where collection_id = collection_row.id;
  end if;

  insert into public.collection_cards (collection_id, name, normalized_name, quantity, unresolved)
  select
    collection_row.id,
    min(btrim(card.name)),
    lower(btrim(card.name)),
    sum(card.quantity),
    bool_or(coalesce(card.unresolved, true))
  from jsonb_to_recordset(p_cards) as card(name text, quantity integer, unresolved boolean)
  group by lower(btrim(card.name));

  return collection_row;
end;
$$;

revoke all on function public.moxscore_replace_collection(uuid, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.moxscore_replace_collection(uuid, text, jsonb, jsonb) to service_role;

revoke all privileges on table public.collections from service_role;
revoke all privileges on table public.collection_cards from service_role;
grant select, insert, update, delete on public.collections to service_role;
grant select, insert, update, delete on public.collection_cards to service_role;
