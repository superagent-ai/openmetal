create type metal.sandbox_status as enum (
  'requested',
  'provisioning',
  'ready',
  'provision_unknown',
  'failed',
  'deleting',
  'deleted',
  'cleanup_pending',
  'cleanup_failed'
);

create table metal.project_api_keys (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  prefix text not null,
  secret_hash text not null unique,
  created_by uuid not null,
  created_at timestamptz not null default timezone('utc', now()),
  last_used_at timestamptz,
  revoked_at timestamptz,
  constraint project_api_keys_name_len check (char_length(name) between 1 and 120),
  constraint project_api_keys_prefix_len check (char_length(prefix) between 8 and 32)
);

create index project_api_keys_project_id_idx
  on metal.project_api_keys (project_id, created_at desc);

create table metal.sandboxes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  project_id uuid not null references public.projects(id),
  provider text not null default 'daytona',
  provider_resource_id text,
  status metal.sandbox_status not null default 'requested',
  image text,
  language text not null default 'typescript',
  ttl_minutes integer not null default 30,
  created_by uuid not null,
  error_code text,
  error_message text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  ready_at timestamptz,
  deleted_at timestamptz,
  constraint sandboxes_provider_daytona check (provider = 'daytona'),
  constraint sandboxes_ttl_range check (ttl_minutes between 1 and 1440)
);

create index sandboxes_project_created_idx
  on metal.sandboxes (project_id, created_at desc);

create unique index sandboxes_provider_resource_key
  on metal.sandboxes (provider, provider_resource_id)
  where provider_resource_id is not null;

alter table metal.project_api_keys enable row level security;
alter table metal.sandboxes enable row level security;

revoke all on table metal.project_api_keys from public, anon, authenticated;
revoke all on table metal.sandboxes from public, anon, authenticated;
