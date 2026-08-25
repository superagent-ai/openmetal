alter table metal.organization_provider_credentials
  add column disabled_at timestamptz;

create index organization_provider_credentials_active_idx
  on metal.organization_provider_credentials(organization_id, provider)
  where disabled_at is null;
