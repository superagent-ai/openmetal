alter table metal.sandboxes
  drop constraint sandboxes_provider_supported,
  add constraint sandboxes_provider_supported
    check (provider in ('daytona', 'e2b', 'modal'));

alter table metal.provider_cost_snapshots
  drop constraint provider_cost_snapshots_provider_supported,
  add constraint provider_cost_snapshots_provider_supported
    check (provider in ('daytona', 'e2b', 'modal'));

alter table metal.sandboxes
  add column provider_metadata jsonb not null default '{}'::jsonb;
