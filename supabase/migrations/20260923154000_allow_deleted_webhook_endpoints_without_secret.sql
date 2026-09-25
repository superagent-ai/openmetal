-- Deleting a webhook endpoint keeps the row for delivery history and removes its Vault
-- secret. Roll forward only: restoring NOT NULL requires hard-deleting soft-deleted endpoints.
alter table metal.webhook_endpoints
  alter column secret_id drop not null,
  add constraint webhook_endpoints_live_secret_check
    check (deleted_at is not null or secret_id is not null);
