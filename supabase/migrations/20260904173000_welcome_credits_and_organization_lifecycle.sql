alter type metal.credit_purchase_source add value if not exists 'welcome_grant';

create table metal.user_welcome_credit_grants (
  user_id uuid primary key references auth.users(id) on delete cascade,
  organization_id uuid not null,
  credit_purchase_id uuid references metal.credit_purchases(id) on delete set null,
  credit_microusd bigint not null default 0,
  status text not null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint user_welcome_credit_grants_amount_nonnegative check (credit_microusd >= 0),
  constraint user_welcome_credit_grants_status_check
    check (status in ('granted', 'ineligible_existing')),
  constraint user_welcome_credit_grants_granted_amount_check
    check (
      (status = 'granted' and credit_microusd > 0)
      or
      (status = 'ineligible_existing' and credit_microusd = 0 and credit_purchase_id is null)
    )
);

create index user_welcome_credit_grants_organization_id_idx
  on metal.user_welcome_credit_grants (organization_id);

insert into metal.user_welcome_credit_grants (
  user_id,
  organization_id,
  credit_microusd,
  status,
  created_at
)
select distinct on (membership.user_id)
  membership.user_id,
  organization.id,
  0,
  'ineligible_existing',
  organization.created_at
from public.organization_members as membership
join public.organizations as organization
  on organization.id = membership.organization_id
where membership.role = 'owner'
order by membership.user_id, organization.created_at, organization.id
on conflict (user_id) do nothing;

alter table metal.user_welcome_credit_grants enable row level security;
revoke all on table metal.user_welcome_credit_grants from public, anon, authenticated;

alter table public.organizations
  add column deleted_at timestamptz;

alter table public.organizations
  drop constraint if exists organizations_slug_key;

create unique index organizations_slug_key
  on public.organizations (slug)
  where deleted_at is null;

create index organizations_active_created_idx
  on public.organizations (created_at)
  where deleted_at is null;
