# ADR 012: OpenMetal CLI packaging

## Context

Customers need an `openmetal` command that wraps the public API and installs without requiring a language runtime. Node.js users also benefit from familiar `npm install --global` and `npx` workflows. The repository already maintains the API client, runtime validation, authentication integration, and tests in TypeScript.

## Decision

Build the CLI from a private TypeScript workspace application in `apps/cli`. Reuse `@openmetal/sdk` and `@openmetal/contracts`, and compile tagged releases into standalone Bun executables for macOS, Linux, and Windows on x64 and arm64. Publish archives and SHA-256 checksums through repository releases, with shell and PowerShell installers.

Publish `@openmetal/cli` as a secondary channel containing one bundled Node.js ESM executable. Generate a clean publish-only manifest so private `workspace:*` packages never appear as registry dependencies. Build the npm package and native binaries from the same tag and version.

The command line remains non-interactive by contract: every operation has flags, environment variables, file/stdin input, and JSON output. TTY detection may add browser login, selectors, confirmations, and progress, but not a full-screen terminal UI.

## Alternatives

- A Go CLI generated from OpenAPI
- npm as the only installation channel
- Node single-executable applications

## Consequences

The CLI shares API validation and retry behavior with the dashboard SDK. Binary users need no runtime, while npm users need Node.js 22 or later. Binaries are larger than an equivalent Go executable, and the repository must pin Bun and test both native and npm artifacts. The first npm version is published from an authenticated maintainer computer; trusted publishing handles later releases without a GitHub npm token.
