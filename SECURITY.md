# Security Policy

## Supported versions

Security fixes are applied to the current production API and the latest published SDK and CLI
releases. Upgrade to the latest available version before reporting an issue that only affects an
older client.

## Report a vulnerability

Report suspected vulnerabilities through a
[private GitHub Security Advisory](https://github.com/superagent-ai/openmetal/security/advisories/new).

Do not open a public issue, discussion, or pull request for an undisclosed vulnerability.

Include:

- The affected OpenMetal component, route, package, and version.
- The security impact and who can be affected.
- Reproduction steps or a minimal proof of concept.
- Any required account role, project scope, provider, or configuration.
- Suggested mitigations, if known.

Remove API keys, access tokens, provider credentials, personal data, and unrelated customer data
from the report. If a credential was exposed while testing, rotate it immediately.

## What happens next

The maintainers will review the advisory, confirm its scope, coordinate remediation and disclosure
with the reporter, and publish an advisory when a fix is available. Please keep details private
until coordinated disclosure is complete.

## Scope

This policy covers the hosted OpenMetal API and dashboard, `@openmetal/sdk`, `@openmetal/cli`, the
OpenMetal Agent Skill, webhook delivery and signature verification, authentication and
authorization, billing, provider credential handling, and sandbox lifecycle or runtime isolation
issues caused by OpenMetal.

Provider vulnerabilities that do not involve OpenMetal should also be reported to the affected
provider.
