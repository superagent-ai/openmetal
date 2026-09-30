# Capability demand

OpenMetal records why each provider was excluded from a sandbox request and which provider-specific options customers send. Three views in the `metal` schema aggregate that data by UTC day. They are revoked from `anon` and `authenticated`, so query them with the service role or from the Supabase SQL editor.

| View                                | One row per                | Answers                                                                             |
| ----------------------------------- | -------------------------- | ----------------------------------------------------------------------------------- |
| `metal.capability_exclusions_daily` | day, provider, requirement | Which requirements remove which providers from candidate lists.                     |
| `metal.unserved_requirements_daily` | day, requirement           | Which requirements appear in requests that failed with `no_eligible_provider`.      |
| `metal.provider_option_usage_daily` | day, provider, option      | Which `provider_options` keys customers send, and how often that provider ran them. |

Requirement codes match `SANDBOX_REQUIREMENTS` in `@openmetal/provider-core`, for example `isolation`, `network.allow_domains`, `process.ordered_output`, or `regions`. The source rows are `metal.provider_attempts.exclusions` and `metal.sandboxes.provider_options`.

## Deciding what to build next

Unserved requirements are demand no provider can currently meet:

```sql
select requirement, sum(sandboxes) as sandboxes, sum(organizations) as organization_days
from metal.unserved_requirements_daily
where day >= current_date - 30
group by requirement
order by sandboxes desc;
```

A requirement that many organizations request, and that at least one provider supports natively, is the next adapter capability to implement and verify. For example, Modal, Runloop, and Vercel document native egress controls that would satisfy `network.*` requirements once an adapter applies them and live tests prove they fail closed.

Provider options show where customers leave the portable API:

```sql
select provider, option, sum(sandboxes) as sandboxes, sum(applied_sandboxes) as applied
from metal.provider_option_usage_daily
where day >= current_date - 30
group by provider, option
order by sandboxes desc;
```

When the same intent appears as options on several providers, such as templates or size tiers, consider a portable field. Promote it only when at least three providers can honor the same semantics and pass the shared conformance tests.
