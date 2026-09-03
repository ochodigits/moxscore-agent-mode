-- Keep anonymous share storage reachable only through the server-side API.
-- Grants and RLS are separate Data API layers; make the intended grants
-- explicit before Supabase's new default-exposure behavior reaches existing
-- projects.

alter table public.shared_decks enable row level security;

drop policy if exists "shared_decks public read" on public.shared_decks;

revoke all privileges on table public.shared_decks from public, anon, authenticated;
grant select, insert on table public.shared_decks to service_role;

-- Pod Check is deferred in v1, but keep its dormant table on the same
-- server-only access model so a public Data API key cannot enumerate it.
alter table public.shared_pods enable row level security;

revoke all privileges on table public.shared_pods from public, anon, authenticated;
grant select, insert on table public.shared_pods to service_role;
