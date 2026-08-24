alter type metal.sandbox_status add value if not exists 'routing';
alter type metal.sandbox_status add value if not exists 'resuming';
alter type metal.sandbox_status add value if not exists 'runtime_unknown';
alter type metal.sandbox_status add value if not exists 'stopping';
alter type metal.sandbox_status add value if not exists 'stopped';

alter table public.projects
  add column public_id text;

update public.projects
set public_id = 'prj_' || replace(id::text, '-', '')
where public_id is null;

alter table public.projects
  alter column public_id set not null,
  alter column public_id set default ('prj_' || replace(gen_random_uuid()::text, '-', ''));

create unique index projects_public_id_key on public.projects(public_id);

create or replace function metal.project_topic_id(p_topic text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
  from public.projects p
  where p.public_id = substr(p_topic, length('project:') + 1)
  limit 1;
$$;

revoke all on function metal.project_topic_id(text) from public, anon;
grant execute on function metal.project_topic_id(text) to authenticated, service_role;

drop policy if exists realtime_select_project_broadcast on realtime.messages;
create policy realtime_select_project_broadcast
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and metal.is_project_member(metal.project_topic_id((select realtime.topic())))
);

alter table metal.sandboxes
  add column public_id text,
  add column primary_provider text,
  add column source jsonb,
  add column resource_requirements jsonb,
  add column resolved_resources jsonb,
  add column lifecycle jsonb,
  add column fallback jsonb,
  add column provider_options jsonb,
  add column environment jsonb,
  add column secret_refs jsonb,
  add column metadata jsonb;

update metal.sandboxes
set
  public_id = 'sbx_' || replace(id::text, '-', ''),
  primary_provider = provider,
  source = jsonb_build_object(
    'kind', 'environment',
    'environment', coalesce(language, 'typescript'),
    'version', 'legacy'
  ),
  resource_requirements = jsonb_build_object(
    'vcpu', 1,
    'memory_mb', 2048,
    'architecture', 'any'
  ),
  lifecycle = jsonb_build_object(
    'runtime_timeout_seconds', ttl_minutes * 60,
    'on_runtime_timeout', 'destroy',
    'on_idle_timeout', 'destroy'
  ),
  fallback = jsonb_build_object('providers', jsonb_build_array()),
  provider_options = '{}'::jsonb,
  environment = '{}'::jsonb,
  secret_refs = '{}'::jsonb,
  metadata = '{}'::jsonb
where public_id is null;

alter table metal.sandboxes
  alter column public_id set not null,
  alter column public_id set default ('sbx_' || replace(gen_random_uuid()::text, '-', '')),
  alter column primary_provider set not null,
  alter column source set not null,
  alter column resource_requirements set not null,
  alter column lifecycle set not null,
  alter column fallback set not null,
  alter column provider_options set not null,
  alter column environment set not null,
  alter column secret_refs set not null,
  alter column metadata set not null;

create unique index sandboxes_public_id_key on metal.sandboxes(public_id);

create table metal.operations (
  id uuid primary key default gen_random_uuid(),
  public_id text not null default ('op_' || replace(gen_random_uuid()::text, '-', '')),
  organization_id uuid not null references public.organizations(id),
  project_id uuid not null references public.projects(id),
  sandbox_id uuid not null references metal.sandboxes(id),
  type text not null,
  state text not null default 'queued',
  retryable boolean not null default false,
  error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create unique index operations_public_id_key on metal.operations(public_id);
create index operations_project_created_idx on metal.operations(project_id, created_at);
create index operations_sandbox_created_idx on metal.operations(sandbox_id, created_at);

create table metal.operation_events (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references metal.operations(id) on delete cascade,
  sequence integer not null,
  type text not null,
  data jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  unique(operation_id, sequence)
);

create table metal.provider_attempts (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references metal.operations(id) on delete cascade,
  sandbox_id uuid not null references metal.sandboxes(id),
  attempt_index integer not null,
  provider text not null,
  state text not null default 'queued',
  provider_resource_id text,
  provider_metadata jsonb not null default '{}'::jsonb,
  resolved_resources jsonb,
  error_code text,
  error_message text,
  outcome text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(operation_id, attempt_index)
);

alter table metal.operations enable row level security;
alter table metal.operation_events enable row level security;
alter table metal.provider_attempts enable row level security;

revoke all on table metal.operations from public, anon, authenticated;
revoke all on table metal.operation_events from public, anon, authenticated;
revoke all on table metal.provider_attempts from public, anon, authenticated;
