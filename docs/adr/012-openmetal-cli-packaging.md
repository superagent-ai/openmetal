# ADR 012: OpenMetal CLI packaging

## Context

Customers need an `openmetal` command that wraps the public API and installs from a release URL without requiring Node.js or an npm publication. The repository already maintains the API client, runtime validation, authentication integration, and tests in TypeScript.

## Decision

Build `@openmetal/cli` as a private TypeScript application in `apps/cli`. Reuse `@openmetal/sdk` and `@openmetal/contracts`, and compile tagged releases into standalone Bun executables for macOS, Linux, and Windows on x64 and arm64. Publish archives and SHA-256 checksums through repository releases, with shell and PowerShell installers.

The command line remains non-interactive by contract: every operation has flags, environment variables, file/stdin input, and JSON output. TTY detection may add browser login, selectors, confirmations, and progress, but not a full-screen terminal UI.

## Alternatives

- A Go CLI generated from OpenAPI
- A Node.js script installed through npm
- Node single-executable applications

## Consequences

The CLI shares API validation and retry behavior with the dashboard SDK and requires no runtime on customer machines. Binaries are larger than an equivalent Go executable, and the repository must pin Bun and test release artifacts across operating systems. npm publication remains unnecessary.
