alter table metal.sandboxes
  drop constraint sandboxes_provider_daytona,
  add constraint sandboxes_provider_supported check (provider in ('daytona', 'modal'));

alter table metal.provider_cost_snapshots
  drop constraint provider_cost_snapshots_provider_daytona,
  add constraint provider_cost_snapshots_provider_supported
    check (provider in ('daytona', 'modal'));
