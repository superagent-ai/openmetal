alter table metal.sandboxes
  add column provider_organization_id text,
  add column provider_cost_microusd bigint,
  add column provider_cost_measured_through timestamptz,
  add column provider_cost_updated_at timestamptz,
  add constraint sandboxes_provider_cost_nonnegative
    check (provider_cost_microusd is null or provider_cost_microusd >= 0);

create table metal.provider_cost_snapshots (
  id uuid primary key default gen_random_uuid(),
  sandbox_id uuid not null references metal.sandboxes(id),
  organization_id uuid not null references public.organizations(id),
  project_id uuid not null references public.projects(id),
  provider text not null,
  provider_resource_id text not null,
  amount_microusd bigint not null,
  measured_through timestamptz not null,
  raw_payload jsonb not null,
  captured_at timestamptz not null default timezone('utc', now()),
  constraint provider_cost_snapshots_amount_nonnegative check (amount_microusd >= 0),
  constraint provider_cost_snapshots_provider_daytona check (provider = 'daytona'),
  constraint provider_cost_snapshots_unique_measurement
    unique (sandbox_id, amount_microusd, measured_through)
);

create index provider_cost_snapshots_sandbox_captured_idx
  on metal.provider_cost_snapshots (sandbox_id, captured_at desc);

alter table metal.provider_cost_snapshots enable row level security;
revoke all on table metal.provider_cost_snapshots from public, anon, authenticated;
