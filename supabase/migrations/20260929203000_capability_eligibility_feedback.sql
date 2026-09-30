alter table metal.provider_attempts
  add column exclusions jsonb not null default '[]'::jsonb,
  add constraint provider_attempts_exclusions_array
    check (jsonb_typeof(exclusions) = 'array');

create index provider_attempts_sandbox_id_idx on metal.provider_attempts (sandbox_id);

-- Requirements that removed a provider from a sandbox's candidate list.
create view metal.capability_exclusions_daily
with (security_invoker = true) as
select
  (a.created_at at time zone 'utc')::date as day,
  a.provider,
  exclusion.value ->> 'requirement' as requirement,
  count(*)::integer as attempts,
  count(distinct a.sandbox_id)::integer as sandboxes,
  count(distinct s.organization_id)::integer as organizations
from metal.provider_attempts a
join metal.sandboxes s on s.id = a.sandbox_id
cross join lateral jsonb_array_elements(a.exclusions) exclusion
group by 1, 2, 3;

-- Requirements behind sandbox requests that no candidate provider could serve.
create view metal.unserved_requirements_daily
with (security_invoker = true) as
select
  (s.created_at at time zone 'utc')::date as day,
  unmet.requirement,
  count(*)::integer as sandboxes,
  count(distinct s.organization_id)::integer as organizations
from metal.sandboxes s
cross join lateral (
  select distinct exclusion.value ->> 'requirement' as requirement
  from metal.provider_attempts a
  cross join lateral jsonb_array_elements(a.exclusions) exclusion
  where a.sandbox_id = s.id
) unmet
where s.error_code = 'no_eligible_provider'
group by 1, 2;

-- Provider-specific options customers send, and how often the sandbox landed on that provider.
create view metal.provider_option_usage_daily
with (security_invoker = true) as
select
  (s.created_at at time zone 'utc')::date as day,
  options.key as provider,
  option_key as option,
  count(*)::integer as sandboxes,
  count(*) filter (
    where s.provider = options.key and s.provider_resource_id is not null
  )::integer as applied_sandboxes,
  count(distinct s.organization_id)::integer as organizations
from metal.sandboxes s
cross join lateral jsonb_each(s.provider_options) options
cross join lateral jsonb_object_keys(
  case when jsonb_typeof(options.value) = 'object' then options.value else '{}'::jsonb end
) option_key
group by 1, 2, 3;

revoke all on table metal.capability_exclusions_daily from public, anon, authenticated;
revoke all on table metal.unserved_requirements_daily from public, anon, authenticated;
revoke all on table metal.provider_option_usage_daily from public, anon, authenticated;
