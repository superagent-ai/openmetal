import { eq, sql } from "drizzle-orm";
import { ProviderCredentialInputSchema } from "@openmetal/contracts";
import { organizationProviderCredentials, type MetalDb } from "@openmetal/db";
import type { SandboxProvider, SandboxProviderName } from "@openmetal/provider-core";
import { buildByokSandboxProvider } from "./provider-registry.js";

type DecryptedCredentialRow = {
  credentialId: string;
  provider: string;
  decryptedSecret: string;
};

export type ResolvedByokProvider = {
  credentialId: string;
  provider?: SandboxProvider;
  invalid?: true;
};

type ValidResolvedByokProvider = ResolvedByokProvider & {
  provider: SandboxProvider;
  invalid?: never;
};

function parseCredential(row: DecryptedCredentialRow): ValidResolvedByokProvider {
  const input = ProviderCredentialInputSchema.parse(JSON.parse(row.decryptedSecret));
  if (input.provider !== row.provider) {
    throw new Error("provider credential metadata does not match its encrypted payload");
  }
  return {
    credentialId: row.credentialId,
    provider: buildByokSandboxProvider(input),
  };
}

export async function listOrganizationByokProviders(
  db: MetalDb,
  organizationId: string,
): Promise<Partial<Record<SandboxProviderName, ResolvedByokProvider>>> {
  const rows = (await db.execute(sql`
    select
      credentials.id as "credentialId",
      credentials.provider,
      secrets.decrypted_secret as "decryptedSecret"
    from metal.organization_provider_credentials credentials
    inner join vault.decrypted_secrets secrets
      on secrets.id = credentials.secret_id
    where credentials.organization_id = ${organizationId}
      and credentials.disabled_at is null
  `)) as unknown as DecryptedCredentialRow[];

  const providers: Partial<Record<SandboxProviderName, ResolvedByokProvider>> = {};
  for (const row of rows) {
    try {
      const resolved = parseCredential(row);
      providers[resolved.provider.name] = resolved;
    } catch {
      providers[row.provider as SandboxProviderName] = {
        credentialId: row.credentialId,
        invalid: true,
      };
    }
  }
  return providers;
}

export async function getByokProviderByCredentialId(
  db: MetalDb,
  credentialId: string,
): Promise<SandboxProvider> {
  const credential = await db
    .select({
      id: organizationProviderCredentials.id,
    })
    .from(organizationProviderCredentials)
    .where(eq(organizationProviderCredentials.id, credentialId))
    .then((rows) => rows[0]);
  if (!credential) {
    throw new Error("sandbox provider credentials are not available");
  }
  const rows = (await db.execute(sql`
    select
      credentials.id as "credentialId",
      credentials.provider,
      secrets.decrypted_secret as "decryptedSecret"
    from metal.organization_provider_credentials credentials
    inner join vault.decrypted_secrets secrets
      on secrets.id = credentials.secret_id
    where credentials.id = ${credential.id}
    limit 1
  `)) as unknown as DecryptedCredentialRow[];
  const row = rows[0];
  if (!row) {
    throw new Error("sandbox provider credentials could not be decrypted");
  }
  return parseCredential(row).provider;
}
