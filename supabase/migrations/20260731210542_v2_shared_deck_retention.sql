-- Anonymous share lifecycle: server-only capability deletion and a fixed
-- 90-day expiry. Existing links retain the same 90-day rule from creation.
alter table public.shared_decks
  add column if not exists expires_at timestamptz;

update public.shared_decks
set expires_at = created_at + interval '90 days'
where expires_at is null;

alter table public.shared_decks
  alter column expires_at set not null,
  alter column expires_at set default (now() + interval '90 days');

alter table public.shared_decks
  add column if not exists deletion_token_hash text;

alter table public.shared_decks
  drop constraint if exists shared_decks_deletion_token_hash;
alter table public.shared_decks
  add constraint shared_decks_deletion_token_hash
  check (deletion_token_hash is null or deletion_token_hash ~ '^[a-f0-9]{64}$');

create index if not exists shared_decks_expires_at_idx
  on public.shared_decks (expires_at);

-- The serverless share and purge functions use the service role. Browser
-- roles remain fully denied by RLS and explicit grants from prior migrations.
revoke all privileges on table public.shared_decks from service_role;
grant select, insert, delete on table public.shared_decks to service_role;
