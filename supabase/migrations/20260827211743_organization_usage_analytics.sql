alter table metal.provider_cost_snapshots
  add column billing_mode text not null default 'managed',
  add column cost_delta_microusd bigint,
  add column measured_from timestamptz,
  add column cost_provenance text not null default 'unknown',
  add column cost_confidence text not null default 'unknown',
  add column cost_source text,
  add column rate_card_version text;

with snapshot_deltas as (
  select
    id,
    amount_microusd
      - coalesce(
          lag(amount_microusd) over (
            partition by sandbox_id
            order by measured_through, captured_at, id
          ),
          0
        ) as cost_delta_microusd,
    lag(measured_through) over (
      partition by sandbox_id
      order by measured_through, captured_at, id
    ) as measured_from
  from metal.provider_cost_snapshots
)
update metal.provider_cost_snapshots as snapshots
set
  cost_delta_microusd = snapshot_deltas.cost_delta_microusd,
  measured_from = snapshot_deltas.measured_from
from snapshot_deltas
where snapshots.id = snapshot_deltas.id;

alter table metal.provider_cost_snapshots
  alter column cost_delta_microusd set not null,
  add constraint provider_cost_snapshots_billing_mode_check
    check (billing_mode in ('managed', 'byok')),
  add constraint provider_cost_snapshots_cost_provenance_check
    check (
      cost_provenance in (
        'provider_reported',
        'provider_metered',
        'estimated_rate_card',
        'unknown'
      )
    ),
  add constraint provider_cost_snapshots_cost_confidence_check
    check (cost_confidence in ('high', 'medium', 'low', 'unknown'));

create index provider_cost_snapshots_organization_measured_idx
  on metal.provider_cost_snapshots (organization_id, measured_through desc);

create index usage_charges_organization_created_idx
  on metal.usage_charges (organization_id, created_at desc);

create index sandboxes_organization_created_idx
  on metal.sandboxes (organization_id, created_at desc);
