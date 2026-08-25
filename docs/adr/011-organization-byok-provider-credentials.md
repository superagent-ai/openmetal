# ADR 011: Organization scoped BYOK provider credentials

## Status

Accepted

## Context

Metal uses managed provider credentials by default. Enterprise organizations also need to run
new sandboxes in their own provider accounts while retaining Metal's API, lifecycle controls, and
routing.

Provider credentials are security sensitive and cannot be stored as recoverable plaintext,
returned through the API, or written to logs. A sandbox must also retain the credential identity
used to create it so later pause, resume, reconciliation, and destroy operations do not
accidentally use Metal's managed account.

## Decision

- BYOK credentials are scoped to an organization and one sandbox provider.
- Credentials are validated with provider specific Zod contracts.
- The complete credential payload is stored as one authenticated encrypted Supabase Vault secret.
  Metal tables retain only the Vault secret identifier and nonsecret audit metadata.
- Only organization owners and administrators may configure or rotate credentials. Members may
  list configured providers, but no API returns secret values.
- A configured organization credential overrides Metal's managed credential for that provider
  during new sandbox provisioning.
- The selected credential identifier and `byok` billing mode are persisted on the provider attempt
  and resulting sandbox.
- Every later lifecycle operation resolves the persisted credential identifier. Credential
  rotation keeps the identifier stable so active sandboxes use the replacement credential.
- Removing a credential disables it for new routing and hides it from organization configuration
  lists. The encrypted value remains available only for lifecycle operations on existing BYOK
  sandboxes. Reconfiguring the provider reactivates the same credential record.
- BYOK sandboxes do not create Metal provider cost snapshots or provider cost synchronization
  jobs. The upstream provider bills the organization directly.
- Managed credentials and Metal credits remain the default when an organization has not configured
  that provider.
- Credential configuration and rotation create append only organization domain events containing
  only the provider name.

## API and SDK

List configured providers:

```ts
const result = await metal.providerCredentials.list(organizationId);
```

Configure or rotate a provider credential:

```ts
await metal.providerCredentials.configure(organizationId, {
  provider: "e2b",
  api_key: process.env.E2B_API_KEY!,
});
```

The configure response contains the provider, organization, and timestamps. It never contains the
submitted credential.

## Limitations

- Configuration does not test the credential against the provider. Provider authentication errors
  are reported when a sandbox operation first uses it.
- Removing credentials stops BYOK routing for new sandboxes but retains encrypted lifecycle access
  for existing sandboxes.
- Provider account charges and quotas remain outside Metal. Metal does not ingest upstream cost for
  BYOK sandboxes.
- BYOK is optional. It does not change managed routing or billing for providers without an
  organization credential.

## Security consequences

- Database backups and replication streams contain authenticated ciphertext rather than plaintext
  credentials.
- The worker database role can read `vault.decrypted_secrets` to construct provider clients. Access
  to that role remains equivalent to access to customer provider accounts.
- Vault tables and the credential metadata table are not granted to `anon` or `authenticated`.
- Secret values exist in API and worker memory only for validation, encryption, and provider client
  construction. They must not be included in errors or structured logs.

## Migration and rollback

The forward migration creates the credential metadata table, Vault cleanup trigger, sandbox
credential reference, provider attempt reference, and sandbox billing mode.

Rolling the application back is safe while leaving these nullable columns and the metadata table in
place. Dropping the schema is not a safe rollback after credentials or BYOK sandboxes exist because
it would remove lifecycle ownership information. A later roll forward must migrate or destroy all
dependent sandboxes before removing the feature.
