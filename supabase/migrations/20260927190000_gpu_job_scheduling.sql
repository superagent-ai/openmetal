-- Region placement and its price multiplier, container start tracking,
-- external bucket mounts, and the funding estimate for managed GPU jobs.

alter table metal.gpu_jobs
  add column placement jsonb not null default '{}'::jsonb,
  add column mounts jsonb not null default '[]'::jsonb,
  add column price_multiplier_bps integer not null default 10000
    check (price_multiplier_bps > 0),
  add column estimated_hourly_microusd bigint not null default 0
    check (estimated_hourly_microusd >= 0),
  add column rate_card_version text,
  add column submitted_at timestamptz;

-- started_at used to record submission; keep that meaning in submitted_at.
update metal.gpu_jobs set submitted_at = started_at where started_at is not null;

create index gpu_jobs_active_managed_idx
  on metal.gpu_jobs (organization_id)
  where billing_mode = 'managed'
    and state in ('provisioning', 'provision_unknown', 'running', 'cancelling');

-- Daily comparison of what Metal metered against what the provider reports
-- billing for the same window, so rate card drift is caught.
create table metal.gpu_cost_reconciliations (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_scope text not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  provider_reported_microusd bigint not null,
  metal_metered_microusd bigint not null,
  drift_microusd bigint not null,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (window_end > window_start),
  unique (provider, provider_scope, window_start, window_end)
);

alter table metal.gpu_cost_reconciliations enable row level security;
revoke all on table metal.gpu_cost_reconciliations from public, anon, authenticated;
