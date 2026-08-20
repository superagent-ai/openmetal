-- Metal Milestone 1 schema, RLS, and private Realtime authorization.
-- Canonical history is this Supabase migration. Drizzle schemas must match it.

create extension if not exists pgcrypto;

create schema if not exists metal;
revoke all on schema metal from public;
revoke all on schema metal from anon, authenticated;
grant usage on schema metal to postgres, service_role;

create type public.organization_role as enum ('owner', 'admin', 'member');
create type metal.outbox_job_status as enum ('pending', 'leased', 'succeeded', 'failed');

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint organizations_name_len check (char_length(name) between 1 and 120),
  constraint organizations_slug_format check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

create table public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.organization_role not null,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, user_id)
);

create index organization_members_user_id_idx on public.organization_members (user_id);
create index organization_members_org_role_idx on public.organization_members (organization_id, role);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  slug text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, slug),
  constraint projects_name_len check (char_length(name) between 1 and 120),
  constraint projects_slug_format check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

create index projects_organization_id_idx on public.projects (organization_id);

create table metal.domain_events (
  cursor bigint generated always as identity primary key,
  event_id uuid not null default gen_random_uuid(),
  type text not null,
  organization_id uuid not null references public.organizations(id),
  project_id uuid references public.projects(id),
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default timezone('utc', now()),
  actor_id uuid not null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint domain_events_event_id_key unique (event_id)
);

create index domain_events_project_cursor_idx on metal.domain_events (project_id, cursor);
create index domain_events_org_cursor_idx on metal.domain_events (organization_id, cursor);

create table metal.outbox_jobs (
  id uuid primary key default gen_random_uuid(),
  job_type text not null,
  dedupe_key text not null,
  payload jsonb not null,
  status metal.outbox_job_status not null default 'pending',
  attempt_count integer not null default 0,
  available_at timestamptz not null default timezone('utc', now()),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  completed_at timestamptz,
  constraint outbox_jobs_dedupe_key_key unique (dedupe_key)
);

create index outbox_jobs_claim_idx
  on metal.outbox_jobs (available_at, created_at)
  where status in ('pending', 'leased');

create table metal.idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  principal_id uuid not null,
  operation text not null,
  key_hash text not null,
  request_fingerprint text not null,
  response_status integer,
  response_body jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint idempotency_keys_scope_key unique (principal_id, operation, key_hash)
);

create or replace function metal.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create trigger organizations_set_updated_at
before update on public.organizations
for each row execute function metal.set_updated_at();

create trigger projects_set_updated_at
before update on public.projects
for each row execute function metal.set_updated_at();

create trigger outbox_jobs_set_updated_at
before update on metal.outbox_jobs
for each row execute function metal.set_updated_at();

create or replace function metal.forbid_domain_event_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'domain_events is append-only';
end;
$$;

create trigger domain_events_no_update
before update or delete on metal.domain_events
for each row execute function metal.forbid_domain_event_mutation();

-- Membership helper lives outside the Data API schema.
-- Threat model: returns only a boolean, binds identity to auth.uid(), cannot
-- mutate memberships, and is not granted to anon.
create or replace function metal.is_organization_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members
    where organization_id = p_organization_id
      and user_id = (select auth.uid())
  );
$$;

create or replace function metal.has_organization_role(
  p_organization_id uuid,
  p_roles public.organization_role[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members
    where organization_id = p_organization_id
      and user_id = (select auth.uid())
      and role = any (p_roles)
  );
$$;

create or replace function metal.is_project_member(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.projects p
    join public.organization_members m
      on m.organization_id = p.organization_id
    where p.id = p_project_id
      and m.user_id = (select auth.uid())
  );
$$;

create or replace function metal.parse_topic_id(p_topic text, p_prefix text)
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  rest text;
begin
  if p_topic is null or p_prefix is null then
    return null;
  end if;
  if split_part(p_topic, ':', 1) <> p_prefix then
    return null;
  end if;
  rest := substr(p_topic, char_length(p_prefix) + 2);
  if rest ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return rest::uuid;
  end if;
  return null;
end;
$$;

revoke all on function metal.is_organization_member(uuid) from public, anon;
revoke all on function metal.has_organization_role(uuid, public.organization_role[]) from public, anon;
revoke all on function metal.is_project_member(uuid) from public, anon;
revoke all on function metal.parse_topic_id(text, text) from public, anon;
grant execute on function metal.is_organization_member(uuid) to authenticated, service_role;
grant execute on function metal.has_organization_role(uuid, public.organization_role[]) to authenticated, service_role;
grant execute on function metal.is_project_member(uuid) to authenticated, service_role;
grant execute on function metal.parse_topic_id(text, text) to authenticated, service_role;

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.projects enable row level security;
alter table metal.domain_events enable row level security;
alter table metal.outbox_jobs enable row level security;
alter table metal.idempotency_keys enable row level security;

revoke all on table public.organizations from public, anon;
revoke all on table public.organization_members from public, anon;
revoke all on table public.projects from public, anon;
revoke all on table metal.domain_events from public, anon, authenticated;
revoke all on table metal.outbox_jobs from public, anon, authenticated;
revoke all on table metal.idempotency_keys from public, anon, authenticated;

grant select on table public.organizations to authenticated;
grant select on table public.organization_members to authenticated;
grant select, insert, update on table public.projects to authenticated;

create policy organizations_select_member
on public.organizations
for select
to authenticated
using (metal.is_organization_member(id));

create policy organization_members_select_member
on public.organization_members
for select
to authenticated
using (metal.is_organization_member(organization_id));

create policy organization_members_no_self_insert
on public.organization_members
for insert
to authenticated
with check (false);

create policy organization_members_no_self_role_update
on public.organization_members
for update
to authenticated
using (false)
with check (false);

create policy projects_select_member
on public.projects
for select
to authenticated
using (metal.is_organization_member(organization_id));

create policy projects_insert_owner_admin
on public.projects
for insert
to authenticated
with check (
  metal.has_organization_role(organization_id, array['owner'::public.organization_role, 'admin'::public.organization_role])
);

create policy projects_update_owner_admin
on public.projects
for update
to authenticated
using (
  metal.has_organization_role(organization_id, array['owner'::public.organization_role, 'admin'::public.organization_role])
)
with check (
  metal.has_organization_role(organization_id, array['owner'::public.organization_role, 'admin'::public.organization_role])
);

create policy realtime_select_organization_broadcast
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and metal.is_organization_member(metal.parse_topic_id((select realtime.topic()), 'organization'))
);

create policy realtime_select_project_broadcast
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and metal.is_project_member(metal.parse_topic_id((select realtime.topic()), 'project'))
);

create policy realtime_authenticated_cannot_publish
on realtime.messages
for insert
to authenticated
with check (false);
