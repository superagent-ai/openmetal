create type metal.pricing_kind as enum ('purchase_fee', 'usage');
create type metal.credit_purchase_source as enum ('checkout', 'auto_topup', 'admin_grant');
create type metal.credit_purchase_status as enum (
  'pending',
  'paid',
  'failed',
  'canceled',
  'requires_action'
);
create type metal.auto_topup_status as enum ('disabled', 'active', 'paused');
create type metal.auto_topup_attempt_status as enum (
  'pending',
  'succeeded',
  'failed',
  'requires_action'
);
create type metal.ledger_transaction_kind as enum (
  'deposit',
  'usage_charge',
  'usage_correction',
  'adjustment'
);
create type metal.ledger_account as enum ('customer_credits', 'platform_clearing');

create table metal.pricing_versions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  kind metal.pricing_kind not null,
  fee_per_mille integer not null default 0,
  min_fee_microusd bigint not null default 0,
  effective_from timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  constraint pricing_versions_fee_per_mille_nonnegative check (fee_per_mille >= 0),
  constraint pricing_versions_min_fee_nonnegative check (min_fee_microusd >= 0)
);

insert into metal.pricing_versions (id, code, kind, fee_per_mille, min_fee_microusd)
values
  (
    '11111111-1111-4111-8111-111111111101',
    'purchase_fee.v1',
    'purchase_fee',
    55,
    800000
  ),
  (
    '11111111-1111-4111-8111-111111111102',
    'usage_passthrough.v1',
    'usage',
    0,
    0
  );

create table metal.billing_accounts (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  stripe_customer_id text,
  stripe_payment_method_id text,
  payment_method_brand text,
  payment_method_last4 text,
  balance_microusd bigint not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index billing_accounts_stripe_customer_id_key
  on metal.billing_accounts (stripe_customer_id)
  where stripe_customer_id is not null;

create table metal.auto_topup_policies (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  enabled boolean not null default false,
  status metal.auto_topup_status not null default 'disabled',
  threshold_microusd bigint not null default 10000000,
  refill_microusd bigint not null default 50000000,
  monthly_cap_microusd bigint not null default 500000000,
  paused_reason text,
  updated_by uuid,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auto_topup_policies_threshold_positive check (threshold_microusd > 0),
  constraint auto_topup_policies_refill_min check (refill_microusd >= 5000000),
  constraint auto_topup_policies_cap_covers_refill check (monthly_cap_microusd >= refill_microusd)
);

create table metal.credit_purchases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source metal.credit_purchase_source not null,
  status metal.credit_purchase_status not null default 'pending',
  credit_microusd bigint not null,
  fee_microusd bigint not null,
  total_microusd bigint not null,
  pricing_version_id uuid not null references metal.pricing_versions(id),
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  stripe_customer_id text,
  actor_id uuid not null,
  created_at timestamptz not null default timezone('utc', now()),
  paid_at timestamptz,
  constraint credit_purchases_amounts_positive check (
    credit_microusd > 0 and fee_microusd >= 0 and total_microusd = credit_microusd + fee_microusd
  )
);

create unique index credit_purchases_stripe_checkout_session_id_key
  on metal.credit_purchases (stripe_checkout_session_id)
  where stripe_checkout_session_id is not null;

create unique index credit_purchases_stripe_payment_intent_id_key
  on metal.credit_purchases (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

create index credit_purchases_organization_created_idx
  on metal.credit_purchases (organization_id, created_at desc);

create table metal.auto_topup_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  purchase_id uuid not null references metal.credit_purchases(id) on delete cascade,
  status metal.auto_topup_attempt_status not null default 'pending',
  window_start timestamptz not null,
  credit_microusd bigint not null,
  fee_microusd bigint not null,
  total_microusd bigint not null,
  stripe_payment_intent_id text,
  error_code text,
  error_message text,
  created_at timestamptz not null default timezone('utc', now()),
  completed_at timestamptz
);

create unique index auto_topup_attempts_purchase_id_key
  on metal.auto_topup_attempts (purchase_id);

create index auto_topup_attempts_org_window_idx
  on metal.auto_topup_attempts (organization_id, window_start, status);

create unique index auto_topup_attempts_pending_org_key
  on metal.auto_topup_attempts (organization_id)
  where status = 'pending';

create table metal.stripe_events (
  event_id text primary key,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  processed_at timestamptz not null default timezone('utc', now())
);

create table metal.ledger_transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind metal.ledger_transaction_kind not null,
  reference_type text not null,
  reference_id uuid not null,
  description text not null,
  actor_id uuid not null,
  created_at timestamptz not null default timezone('utc', now())
);

create index ledger_transactions_organization_created_idx
  on metal.ledger_transactions (organization_id, created_at desc);

create table metal.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references metal.ledger_transactions(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  account metal.ledger_account not null,
  amount_microusd bigint not null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint ledger_entries_amount_nonzero check (amount_microusd <> 0)
);

create index ledger_entries_transaction_idx
  on metal.ledger_entries (transaction_id);

create index ledger_entries_organization_created_idx
  on metal.ledger_entries (organization_id, created_at desc);

create table metal.usage_charges (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  sandbox_id uuid not null references metal.sandboxes(id) on delete cascade,
  snapshot_id uuid not null references metal.provider_cost_snapshots(id),
  pricing_version_id uuid not null references metal.pricing_versions(id),
  provider_cost_delta_microusd bigint not null,
  customer_charge_microusd bigint not null,
  measured_from timestamptz,
  measured_through timestamptz not null,
  ledger_transaction_id uuid not null references metal.ledger_transactions(id),
  created_at timestamptz not null default timezone('utc', now()),
  constraint usage_charges_passthrough check (customer_charge_microusd = provider_cost_delta_microusd)
);

create unique index usage_charges_snapshot_id_key
  on metal.usage_charges (snapshot_id);

create index usage_charges_sandbox_created_idx
  on metal.usage_charges (sandbox_id, created_at desc);

alter table metal.sandboxes
  add column customer_charged_microusd bigint not null default 0;

insert into metal.billing_accounts (organization_id)
select id from public.organizations
on conflict (organization_id) do nothing;

insert into metal.auto_topup_policies (organization_id)
select id from public.organizations
on conflict (organization_id) do nothing;

create or replace function metal.forbid_ledger_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'ledger records are append-only';
end;
$$;

create trigger ledger_transactions_immutable
before update or delete on metal.ledger_transactions
for each row execute function metal.forbid_ledger_mutation();

create trigger ledger_entries_immutable
before update or delete on metal.ledger_entries
for each row execute function metal.forbid_ledger_mutation();

create or replace function metal.assert_ledger_transaction_balanced()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  total bigint;
begin
  select coalesce(sum(amount_microusd), 0) into total
  from metal.ledger_entries
  where transaction_id = new.transaction_id;
  if total <> 0 then
    raise exception 'ledger transaction % is not balanced', new.transaction_id;
  end if;
  return null;
end;
$$;

create constraint trigger ledger_entries_balanced
after insert on metal.ledger_entries
deferrable initially deferred
for each row execute function metal.assert_ledger_transaction_balanced();

create trigger billing_accounts_set_updated_at
before update on metal.billing_accounts
for each row execute function metal.set_updated_at();

create trigger auto_topup_policies_set_updated_at
before update on metal.auto_topup_policies
for each row execute function metal.set_updated_at();

alter table metal.pricing_versions enable row level security;
alter table metal.billing_accounts enable row level security;
alter table metal.auto_topup_policies enable row level security;
alter table metal.credit_purchases enable row level security;
alter table metal.auto_topup_attempts enable row level security;
alter table metal.stripe_events enable row level security;
alter table metal.ledger_transactions enable row level security;
alter table metal.ledger_entries enable row level security;
alter table metal.usage_charges enable row level security;

revoke all on table metal.pricing_versions from public, anon, authenticated;
revoke all on table metal.billing_accounts from public, anon, authenticated;
revoke all on table metal.auto_topup_policies from public, anon, authenticated;
revoke all on table metal.credit_purchases from public, anon, authenticated;
revoke all on table metal.auto_topup_attempts from public, anon, authenticated;
revoke all on table metal.stripe_events from public, anon, authenticated;
revoke all on table metal.ledger_transactions from public, anon, authenticated;
revoke all on table metal.ledger_entries from public, anon, authenticated;
revoke all on table metal.usage_charges from public, anon, authenticated;
