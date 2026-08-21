alter table metal.sandboxes
  drop constraint sandboxes_provider_supported,
  add constraint sandboxes_provider_supported
    check (provider in ('blaxel', 'cloudflare', 'daytona', 'e2b', 'modal', 'vercel'));

alter table metal.provider_cost_snapshots
  drop constraint provider_cost_snapshots_provider_supported,
  add constraint provider_cost_snapshots_provider_supported
    check (provider in ('blaxel', 'cloudflare', 'daytona', 'e2b', 'modal', 'vercel'));
