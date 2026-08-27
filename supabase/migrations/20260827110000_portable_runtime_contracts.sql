create type metal.process_state as enum (
  'queued',
  'running',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out'
);

create type metal.runtime_operation_kind as enum (
  'filesystem_read',
  'filesystem_write',
  'filesystem_list',
  'filesystem_delete'
);

create type metal.runtime_operation_state as enum (
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled'
);

create type metal.sandbox_endpoint_state as enum (
  'provisioning',
  'active',
  'revoking',
  'revoked',
  'expired',
  'failed'
);

create table metal.sandbox_processes (
  id uuid primary key default gen_random_uuid(),
  public_id text not null default ('proc_' || replace(gen_random_uuid()::text, '-', '')),
  organization_id uuid not null references public.organizations(id),
  project_id uuid not null references public.projects(id),
  sandbox_id uuid not null references metal.sandboxes(id),
  state metal.process_state not null default 'queued',
  command jsonb not null,
  cwd text,
  environment jsonb not null default '{}'::jsonb,
  timeout_seconds integer not null default 300,
  max_output_bytes integer not null default 10485760,
  output_bytes integer not null default 0,
  exit_code integer,
  termination_signal text,
  error jsonb,
  provider_capabilities jsonb,
  cancel_requested_at timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  constraint sandbox_processes_public_id_format check (public_id ~ '^proc_[A-Za-z0-9]+$'),
  constraint sandbox_processes_command_array check (
    jsonb_typeof(command) = 'array'
    and jsonb_array_length(command) between 1 and 4096
  ),
  constraint sandbox_processes_environment_object check (jsonb_typeof(environment) = 'object'),
  constraint sandbox_processes_timeout_bounds check (timeout_seconds between 1 and 3600),
  constraint sandbox_processes_output_bounds check (
    max_output_bytes between 1 and 104857600
    and output_bytes between 0 and max_output_bytes
  )
);

create unique index sandbox_processes_public_id_key
  on metal.sandbox_processes(public_id);
create index sandbox_processes_sandbox_created_idx
  on metal.sandbox_processes(sandbox_id, created_at);
create index sandbox_processes_project_created_idx
  on metal.sandbox_processes(project_id, created_at);
create index sandbox_processes_terminal_completed_at_idx
  on metal.sandbox_processes(completed_at)
  where state in ('succeeded', 'failed', 'cancelled', 'timed_out');

create table metal.process_events (
  id uuid primary key default gen_random_uuid(),
  process_id uuid not null references metal.sandbox_processes(id) on delete cascade,
  sequence integer not null,
  type text not null,
  data jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  constraint process_events_positive_sequence check (sequence > 0),
  constraint process_events_known_type check (
    type in ('queued', 'started', 'stdout', 'stderr', 'exited', 'cancelled', 'timed_out', 'failed')
  ),
  constraint process_events_data_object check (jsonb_typeof(data) = 'object'),
  unique(process_id, sequence)
);

create table metal.runtime_operations (
  id uuid primary key default gen_random_uuid(),
  public_id text not null default ('rop_' || replace(gen_random_uuid()::text, '-', '')),
  organization_id uuid not null references public.organizations(id),
  project_id uuid not null references public.projects(id),
  sandbox_id uuid not null references metal.sandboxes(id),
  kind metal.runtime_operation_kind not null,
  state metal.runtime_operation_state not null default 'queued',
  request jsonb not null,
  result jsonb,
  error jsonb,
  provider_capabilities jsonb,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  constraint runtime_operations_public_id_format check (public_id ~ '^rop_[A-Za-z0-9]+$'),
  constraint runtime_operations_request_object check (jsonb_typeof(request) = 'object'),
  constraint runtime_operations_result_object check (
    result is null or jsonb_typeof(result) = 'object'
  ),
  constraint runtime_operations_error_object check (
    error is null or jsonb_typeof(error) = 'object'
  )
);

create unique index runtime_operations_public_id_key
  on metal.runtime_operations(public_id);
create index runtime_operations_sandbox_created_idx
  on metal.runtime_operations(sandbox_id, created_at);
create index runtime_operations_project_created_idx
  on metal.runtime_operations(project_id, created_at);

create table metal.sandbox_endpoints (
  id uuid primary key default gen_random_uuid(),
  public_id text not null default ('ep_' || replace(gen_random_uuid()::text, '-', '')),
  organization_id uuid not null references public.organizations(id),
  project_id uuid not null references public.projects(id),
  sandbox_id uuid not null references metal.sandboxes(id),
  port integer not null,
  protocol text not null default 'http',
  state metal.sandbox_endpoint_state not null default 'provisioning',
  url text,
  lease_expires_at timestamptz not null default (now() + interval '1 hour'),
  revoked_at timestamptz,
  error jsonb,
  provider_metadata jsonb not null default '{}'::jsonb,
  provider_capabilities jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sandbox_endpoints_public_id_format check (public_id ~ '^ep_[A-Za-z0-9]+$'),
  constraint sandbox_endpoints_port_bounds check (port between 1 and 65535),
  constraint sandbox_endpoints_http_only check (protocol = 'http'),
  constraint sandbox_endpoints_lease_bounds check (
    lease_expires_at between
      created_at + interval '60 seconds'
      and created_at + interval '86400 seconds'
  ),
  constraint sandbox_endpoints_provider_metadata_object check (
    jsonb_typeof(provider_metadata) = 'object'
  )
);

create unique index sandbox_endpoints_public_id_key
  on metal.sandbox_endpoints(public_id);
create index sandbox_endpoints_sandbox_created_idx
  on metal.sandbox_endpoints(sandbox_id, created_at);
create index sandbox_endpoints_lease_expiry_idx
  on metal.sandbox_endpoints(lease_expires_at)
  where state in ('provisioning', 'active', 'revoking');
create unique index sandbox_endpoints_active_port_key
  on metal.sandbox_endpoints(sandbox_id, port)
  where state in ('provisioning', 'active', 'revoking');

alter table metal.sandbox_processes enable row level security;
alter table metal.process_events enable row level security;
alter table metal.runtime_operations enable row level security;
alter table metal.sandbox_endpoints enable row level security;

revoke all on table metal.sandbox_processes from public, anon, authenticated;
revoke all on table metal.process_events from public, anon, authenticated;
revoke all on table metal.runtime_operations from public, anon, authenticated;
revoke all on table metal.sandbox_endpoints from public, anon, authenticated;

alter table metal.outbox_jobs
  add column lease_token uuid;

alter table metal.sandbox_processes
  add column provider_execution_id text,
  add column operation_token uuid,
  add column output_truncated boolean not null default false;

alter table metal.runtime_operations
  add column operation_token uuid;

alter table metal.sandbox_endpoints
  add column operation_token uuid;

