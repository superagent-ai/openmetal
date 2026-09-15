# Contributing to OpenMetal

Thank you for contributing to OpenMetal.

## Before you start

- Search existing issues and pull requests before opening new work.
- Open an issue for substantial features, API changes, or architectural changes before
  implementation.
- Report vulnerabilities through the process in [SECURITY.md](SECURITY.md), not a public issue.

## Development setup

OpenMetal requires Node.js 22 or later, pnpm 11.13.1, Bun 1.3.11, Docker, and the Supabase CLI.

```bash
pnpm install --frozen-lockfile
pnpm supabase:start
pnpm env:local
pnpm dev
```

The web app runs on `http://localhost:3100` and the API runs on `http://localhost:4000`.

## Make a change

1. Create a focused branch from the latest `main`.
2. Keep changes scoped to one concern.
3. Add or update tests for behavior changes.
4. Regenerate derived files when changing contracts:

   ```bash
   pnpm docs:generate
   pnpm db:types
   ```

5. Do not commit credentials, decrypted environment files, generated local state, or provider
   secrets.

## Validate

Run the checks relevant to your change. Before requesting review, run:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Database, Realtime, and full-stack changes might also require:

```bash
pnpm test:integration
pnpm test:rls
pnpm test:realtime
```

## Pull requests

- Explain what changed and why.
- Keep generated contract, documentation, and database type changes in sync with their source.
- Include verification steps and note any checks that could not run.
- Update public documentation for user-facing changes.
- Avoid unrelated cleanup in the same pull request.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE.md) that covers this repository.
