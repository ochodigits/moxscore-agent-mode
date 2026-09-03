-- The tables were originally created with broad service-role privileges.
-- GRANT SELECT, INSERT is additive, so reset that role explicitly before
-- granting the only operations used by the v1 server API.

revoke all privileges on table public.shared_decks from service_role;
grant select, insert on table public.shared_decks to service_role;

revoke all privileges on table public.shared_pods from service_role;
grant select, insert on table public.shared_pods to service_role;
