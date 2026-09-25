alter table metal.sandboxes
  drop constraint sandboxes_provider_supported,
  add constraint sandboxes_provider_supported
    check (provider in ('blaxel', 'cloudflare', 'codesandbox', 'daytona', 'e2b', 'freestyle', 'modal', 'northflank', 'prime', 'runloop', 'vercel'));

alter table metal.provider_cost_snapshots
  drop constraint provider_cost_snapshots_provider_supported,
  add constraint provider_cost_snapshots_provider_supported
    check (provider in ('blaxel', 'cloudflare', 'codesandbox', 'daytona', 'e2b', 'freestyle', 'modal', 'northflank', 'prime', 'runloop', 'vercel'));

alter table metal.organization_provider_credentials
  drop constraint organization_provider_credentials_provider_check,
  add constraint organization_provider_credentials_provider_check
    check (provider in ('blaxel', 'cloudflare', 'codesandbox', 'daytona', 'e2b', 'freestyle', 'modal', 'northflank', 'prime', 'runloop', 'vercel'));
