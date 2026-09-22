alter table metal.sandboxes
  add column provider_capabilities jsonb;

alter type metal.runtime_operation_kind add value if not exists 'computer_action';
alter type metal.runtime_operation_kind add value if not exists 'computer_screenshot';

create type metal.sandbox_recording_state as enum (
  'starting',
  'recording',
  'stopping',
  'stopped',
  'failed'
);

create table metal.sandbox_recordings (
  id uuid primary key default gen_random_uuid(),
  public_id text not null default ('rec_' || replace(gen_random_uuid()::text, '-', '')),
  organization_id uuid not null references public.organizations(id),
  project_id uuid not null references public.projects(id),
  sandbox_id uuid not null references metal.sandboxes(id),
  state metal.sandbox_recording_state not null default 'starting',
  format text not null default 'mp4',
  label text,
  provider_recording_id text,
  file_path text,
  size_bytes bigint,
  duration_seconds integer,
  error jsonb,
  provider_capabilities jsonb,
  operation_token uuid,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  stopped_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint sandbox_recordings_public_id_format check (public_id ~ '^rec_[A-Za-z0-9]+$'),
  constraint sandbox_recordings_mp4_only check (format = 'mp4'),
  constraint sandbox_recordings_file_path_absolute check (
    file_path is null or file_path like '/%'
  ),
  constraint sandbox_recordings_size_nonnegative check (
    size_bytes is null or size_bytes >= 0
  ),
  constraint sandbox_recordings_duration_nonnegative check (
    duration_seconds is null or duration_seconds >= 0
  ),
  constraint sandbox_recordings_error_object check (
    error is null or jsonb_typeof(error) = 'object'
  )
);

create unique index sandbox_recordings_public_id_key
  on metal.sandbox_recordings(public_id);
create index sandbox_recordings_sandbox_created_idx
  on metal.sandbox_recordings(sandbox_id, created_at);
create index sandbox_recordings_project_created_idx
  on metal.sandbox_recordings(project_id, created_at);

alter table metal.sandbox_recordings enable row level security;
revoke all on table metal.sandbox_recordings from public, anon, authenticated;
