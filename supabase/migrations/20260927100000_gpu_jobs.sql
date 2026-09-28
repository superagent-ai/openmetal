-- GPU jobs run a container to completion on provider GPUs. They share
-- operations, provider attempts, cost snapshots, and usage charges with
-- sandboxes, so those tables now reference exactly one of the two resources.

create table metal.gpu_jobs (
  id uuid primary key default gen_random_uuid(),
  public_id text not null default ('gpj_' || replace(gen_random_uuid()::text, '-', '')),
  organization_id uuid not null references public.organizations(id),
  project_id uuid not null references public.projects(id),
  created_by uuid not null,
  primary_provider text not null,
  provider text,
  provider_credential_id uuid references metal.organization_provider_credentials(id),
  billing_mode text not null default 'managed' check (billing_mode in ('managed', 'byok')),
  provider_resource_id text,
  provider_organization_id text,
  provider_metadata jsonb not null default '{}'::jsonb,
  state text not null default 'requested' check (
    state in (
      'requested',
      'provisioning',
      'provision_unknown',
      'running',
      'cancelling',
      'succeeded',
      'failed',
      'timed_out',
      'cancelled'
    )
  ),
  state_reason text,
  failure_code text,
  failure_message text,
  source jsonb not null,
  gpu jsonb not null,
  resources jsonb not null default '{}'::jsonb,
  lifecycle jsonb not null,
  limits jsonb not null default '{}'::jsonb,
  max_cost_microusd bigint check (max_cost_microusd is null or max_cost_microusd > 0),
  environment jsonb not null default '{}'::jsonb,
  secret_names jsonb not null default '[]'::jsonb,
  secrets_vault_id uuid,
  provider_options jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  resolved jsonb,
  exit_code integer,
  log_cursors jsonb not null default '{}'::jsonb,
  log_stream_offsets jsonb not null default '{}'::jsonb,
  log_bytes bigint not null default 0 check (log_bytes >= 0),
  logs_truncated boolean not null default false,
  logs_complete boolean not null default false,
  provider_cost_microusd bigint,
  provider_cost_measured_through timestamptz,
  provider_cost_updated_at timestamptz,
  customer_charged_microusd bigint not null default 0,
  deadline_at timestamptz,
  cancel_requested_at timestamptz,
  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  check (
    (state in ('succeeded', 'failed', 'timed_out', 'cancelled')) = (finished_at is not null)
  )
);

create unique index gpu_jobs_public_id_key on metal.gpu_jobs (public_id);
create index gpu_jobs_project_created_idx on metal.gpu_jobs (project_id, created_at desc, id desc);
create index gpu_jobs_organization_created_idx on metal.gpu_jobs (organization_id, created_at desc);
create unique index gpu_jobs_provider_resource_key
  on metal.gpu_jobs (provider, provider_resource_id)
  where provider_resource_id is not null;
create index gpu_jobs_active_organization_idx
  on metal.gpu_jobs (organization_id, billing_mode)
  where state not in ('succeeded', 'failed', 'timed_out', 'cancelled');
create index gpu_jobs_provider_credential_id_idx
  on metal.gpu_jobs (provider_credential_id)
  where provider_credential_id is not null;
create index gpu_jobs_finished_idx
  on metal.gpu_jobs (finished_at)
  where finished_at is not null;

create trigger gpu_jobs_set_updated_at
before update on metal.gpu_jobs
for each row execute function metal.set_updated_at();

create table metal.gpu_job_log_events (
  id uuid primary key default gen_random_uuid(),
  gpu_job_id uuid not null references metal.gpu_jobs(id) on delete cascade,
  sequence integer not null check (sequence > 0),
  type text not null check (type in ('stdout', 'stderr', 'truncated')),
  data jsonb not null,
  occurred_at timestamptz not null default now(),
  unique (gpu_job_id, sequence)
);

alter table metal.gpu_jobs enable row level security;
alter table metal.gpu_job_log_events enable row level security;
revoke all on table metal.gpu_jobs from public, anon, authenticated;
revoke all on table metal.gpu_job_log_events from public, anon, authenticated;

-- Job secrets live in Vault only while the job can still start. The worker
-- purges them once the job is terminal; deleting a job row purges them too.
create function metal.purge_gpu_job_secrets(target_gpu_job_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_secret_id uuid;
begin
  select secrets_vault_id into target_secret_id
  from metal.gpu_jobs
  where id = target_gpu_job_id
  for update;
  if target_secret_id is not null then
    update metal.gpu_jobs set secrets_vault_id = null where id = target_gpu_job_id;
    delete from vault.secrets where id = target_secret_id;
  end if;
end;
$$;

revoke all on function metal.purge_gpu_job_secrets(uuid) from public, anon, authenticated;

create function metal.delete_gpu_job_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.secrets_vault_id is not null then
    delete from vault.secrets where id = old.secrets_vault_id;
  end if;
  return old;
end;
$$;

revoke all on function metal.delete_gpu_job_secret() from public, anon, authenticated;

create trigger delete_gpu_job_secret
after delete on metal.gpu_jobs
for each row execute function metal.delete_gpu_job_secret();

alter table metal.operations
  alter column sandbox_id drop not null,
  add column gpu_job_id uuid references metal.gpu_jobs(id),
  add constraint operations_single_resource check (num_nonnulls(sandbox_id, gpu_job_id) = 1);
create index operations_gpu_job_created_idx
  on metal.operations (gpu_job_id, created_at)
  where gpu_job_id is not null;

alter table metal.provider_attempts
  alter column sandbox_id drop not null,
  add column gpu_job_id uuid references metal.gpu_jobs(id),
  add constraint provider_attempts_single_resource
    check (num_nonnulls(sandbox_id, gpu_job_id) = 1);

alter table metal.provider_cost_snapshots
  alter column sandbox_id drop not null,
  add column gpu_job_id uuid references metal.gpu_jobs(id),
  add constraint provider_cost_snapshots_single_resource
    check (num_nonnulls(sandbox_id, gpu_job_id) = 1);
create index provider_cost_snapshots_gpu_job_captured_idx
  on metal.provider_cost_snapshots (gpu_job_id, captured_at)
  where gpu_job_id is not null;
create unique index provider_cost_snapshots_gpu_job_unique_measurement
  on metal.provider_cost_snapshots (gpu_job_id, amount_microusd, measured_through)
  where gpu_job_id is not null;

alter table metal.usage_charges
  alter column sandbox_id drop not null,
  add column gpu_job_id uuid references metal.gpu_jobs(id) on delete cascade,
  add constraint usage_charges_single_resource check (num_nonnulls(sandbox_id, gpu_job_id) = 1);
create index usage_charges_gpu_job_created_idx
  on metal.usage_charges (gpu_job_id, created_at desc)
  where gpu_job_id is not null;

-- GPU job lifecycle jobs never overlap on the same job.
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
