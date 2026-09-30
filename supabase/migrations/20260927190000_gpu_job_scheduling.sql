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

-- The periodic GPU sweeps talk to provider accounts, so at most one of each
-- runs at a time across all workers, even after a backlog of periods.
create or replace function metal.set_outbox_job_lock()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  target_sandbox_id uuid;
begin
  new.lock_key := null;
  new.lock_mode := null;
  case new.job_type
    when 'sandbox.provision', 'sandbox.reconcile', 'sandbox.pause', 'sandbox.resume',
      'sandbox.destroy' then
      new.lock_key := 'sandbox:' || (new.payload ->> 'sandbox_id');
      new.lock_mode := 'exclusive';
    when 'sandbox.cost.sync' then
      new.lock_key := 'sandbox:' || (new.payload ->> 'sandbox_id');
      new.lock_mode := 'shared';
    when 'gpu_job.submit', 'gpu_job.monitor', 'gpu_job.cancel', 'gpu_job.cost.sync' then
      new.lock_key := 'gpu_job:' || (new.payload ->> 'gpu_job_id');
      new.lock_mode := 'exclusive';
    when 'gpu_job.orphan_sweep', 'gpu_job.cost_reconcile' then
      new.lock_key := new.job_type;
      new.lock_mode := 'exclusive';
    when 'billing.auto_topup.evaluate', 'billing.spend_limit.enforce' then
      new.lock_key := 'organization:' || (new.payload ->> 'organization_id');
      new.lock_mode := 'exclusive';
    when 'process.execute' then
      select sandbox_id into target_sandbox_id
      from metal.sandbox_processes
      where id = (new.payload ->> 'process_id')::uuid;
    when 'filesystem.read', 'filesystem.write', 'filesystem.list', 'filesystem.delete',
      'computer.action', 'computer.screenshot' then
      select sandbox_id into target_sandbox_id
      from metal.runtime_operations
      where id = (new.payload ->> 'runtime_operation_id')::uuid;
    when 'recording.start', 'recording.stop' then
      select sandbox_id into target_sandbox_id
      from metal.sandbox_recordings
      where id = (new.payload ->> 'recording_id')::uuid;
    when 'endpoint.create', 'endpoint.revoke' then
      select sandbox_id into target_sandbox_id
      from metal.sandbox_endpoints
      where id = (new.payload ->> 'endpoint_id')::uuid;
    else
      null;
  end case;
  if target_sandbox_id is not null then
    new.lock_key := 'sandbox:' || target_sandbox_id::text;
    new.lock_mode := 'shared';
  end if;
  if new.lock_key is null then
    new.lock_mode := null;
  end if;
  return new;
end;
$$;
