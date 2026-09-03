-- Short-lived server-only idempotency receipts for the irreversible account
-- deletion operation. They intentionally do not reference auth.users: the
-- receipt must survive the Auth cascade long enough for a caller to retry a
-- lost success response. Only a SHA-256 capability hash is stored.

create table if not exists public.account_deletion_receipts (
  token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid not null,
  expires_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists account_deletion_receipts_expiry_idx
  on public.account_deletion_receipts (expires_at);

alter table public.account_deletion_receipts enable row level security;
revoke all privileges on table public.account_deletion_receipts from public, anon, authenticated;
revoke all privileges on table public.account_deletion_receipts from service_role;
grant select, insert, update, delete on table public.account_deletion_receipts to service_role;
