create extension if not exists supabase_vault with schema vault;

create table metal.organization_provider_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null check (
    provider in (
      'blaxel',
      'cloudflare',
      'codesandbox',
      'daytona',
      'e2b',
      'modal',
      'northflank',
      'runloop',
      'vercel'
    )
  ),
  secret_id uuid not null references vault.secrets(id),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider)
);

create index organization_provider_credentials_organization_idx
  on metal.organization_provider_credentials(organization_id, provider);

alter table metal.organization_provider_credentials enable row level security;
revoke all on table metal.organization_provider_credentials from public, anon, authenticated;

create function metal.delete_provider_credential_secret()
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

revoke all on function metal.delete_provider_credential_secret() from public, anon, authenticated;

create trigger delete_provider_credential_secret
after delete on metal.organization_provider_credentials
for each row execute function metal.delete_provider_credential_secret();

alter table metal.sandboxes
  add column provider_credential_id uuid
    references metal.organization_provider_credentials(id),
  add column billing_mode text not null default 'managed'
    check (billing_mode in ('managed', 'byok'));

create index sandboxes_provider_credential_id_idx
  on metal.sandboxes(provider_credential_id)
  where provider_credential_id is not null;

alter table metal.provider_attempts
  add column provider_credential_id uuid
    references metal.organization_provider_credentials(id);
