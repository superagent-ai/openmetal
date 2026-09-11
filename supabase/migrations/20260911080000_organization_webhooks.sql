create extension if not exists supabase_vault with schema vault;

do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'metal' and t.typname = 'webhook_delivery_status') then
    create type metal.webhook_delivery_status as enum (
      'pending',
      'delivering',
      'succeeded',
      'retrying',
      'failed'
    );
  end if;
end;
$$;

create table metal.webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  url text not null check (char_length(url) between 1 and 2048),
  event_types jsonb not null default '[]'::jsonb,
  enabled boolean not null default true,
  secret_id uuid not null references vault.secrets(id),
  secret_prefix text not null,
  created_by uuid not null,
  rotated_at timestamptz,
  rotated_by uuid,
  last_delivery_at timestamptz,
  last_delivery_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disabled_at timestamptz,
  deleted_at timestamptz
);

create index webhook_endpoints_organization_idx
  on metal.webhook_endpoints(organization_id, created_at);
create index webhook_endpoints_active_org_idx
  on metal.webhook_endpoints(organization_id, enabled)
  where deleted_at is null and disabled_at is null;

create table metal.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references metal.webhook_endpoints(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event_id text not null,
  event_type text not null,
  event jsonb not null default '{}'::jsonb,
  endpoint_url text not null,
  status metal.webhook_delivery_status not null default 'pending',
  attempt_count integer not null default 0,
  next_attempt_at timestamptz,
  last_http_status integer,
  last_error text,
  last_latency_ms integer,
  response_snippet text,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  delivered_at timestamptz,
  constraint webhook_deliveries_endpoint_event_key unique (endpoint_id, event_id)
);

create index webhook_deliveries_endpoint_created_idx
  on metal.webhook_deliveries(endpoint_id, created_at);
create index webhook_deliveries_organization_created_idx
  on metal.webhook_deliveries(organization_id, created_at);
create index webhook_deliveries_retry_idx
  on metal.webhook_deliveries(status, next_attempt_at)
  where status in ('pending', 'retrying');

alter table metal.webhook_endpoints enable row level security;
alter table metal.webhook_deliveries enable row level security;
revoke all on table metal.webhook_endpoints from public, anon, authenticated;
revoke all on table metal.webhook_deliveries from public, anon, authenticated;

create trigger webhook_endpoints_set_updated_at
before update on metal.webhook_endpoints
for each row execute function metal.set_updated_at();

create trigger webhook_deliveries_set_updated_at
before update on metal.webhook_deliveries
for each row execute function metal.set_updated_at();

create function metal.delete_webhook_endpoint_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets where id = old.secret_id;
  return old;
end;
$$;

revoke all on function metal.delete_webhook_endpoint_secret() from public, anon, authenticated;

create trigger delete_webhook_endpoint_secret
after delete on metal.webhook_endpoints
for each row execute function metal.delete_webhook_endpoint_secret();
