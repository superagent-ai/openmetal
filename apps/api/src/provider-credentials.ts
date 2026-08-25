import { and, eq, isNull, sql } from "drizzle-orm";
import {
  domainEvents,
  organizationProviderCredentials,
  withTransaction,
  type MetalDb,
} from "@openmetal/db";
import { ProviderCredentialInputSchema, type ProviderCredentialInput } from "@openmetal/contracts";
import { ApiError } from "./errors.js";
import { requireMembership } from "./services.js";

export async function listOrganizationProviderCredentials(
  db: MetalDb,
  input: { userId: string; organizationId: string },
) {
  await requireMembership(db, input.userId, input.organizationId);
  return db
    .select()
    .from(organizationProviderCredentials)
    .where(
      and(
        eq(organizationProviderCredentials.organizationId, input.organizationId),
        isNull(organizationProviderCredentials.disabledAt),
      ),
    );
}

export async function configureOrganizationProviderCredential(
  db: MetalDb,
  input: {
    userId: string;
    organizationId: string;
    credential: ProviderCredentialInput;
  },
) {
  return withTransaction(db, async (tx) => {
    await requireMembership(tx, input.userId, input.organizationId, ["owner", "admin"]);
    const existing = await tx
      .select()
      .from(organizationProviderCredentials)
      .where(
        and(
          eq(organizationProviderCredentials.organizationId, input.organizationId),
          eq(organizationProviderCredentials.provider, input.credential.provider),
        ),
      )
      .then((rows) => rows[0]);
    let credentialValue = input.credential;
    if (existing) {
      const decryptedRows = (await tx.execute(sql`
        select decrypted_secret as "decryptedSecret"
        from vault.decrypted_secrets
        where id = ${existing.secretId}
        limit 1
      `)) as unknown as Array<{ decryptedSecret: string }>;
      try {
        const previous = ProviderCredentialInputSchema.parse(
          JSON.parse(decryptedRows[0]?.decryptedSecret ?? "null"),
        );
        if (previous.provider === input.credential.provider) {
          credentialValue = ProviderCredentialInputSchema.parse({
            ...previous,
            ...input.credential,
          });
        }
      } catch {
        // A valid replacement repairs malformed or legacy credential payloads.
      }
    }
    const serialized = JSON.stringify(credentialValue);
    const now = new Date();

    let credential: typeof organizationProviderCredentials.$inferSelect | undefined;
    let created = false;
    if (existing) {
      await tx.execute(sql`select vault.update_secret(${existing.secretId}, ${serialized})`);
      [credential] = await tx
        .update(organizationProviderCredentials)
        .set({ updatedAt: now, disabledAt: null })
        .where(eq(organizationProviderCredentials.id, existing.id))
        .returning();
    } else {
      const secretName = `metal:${input.organizationId}:${input.credential.provider}`;
      const secretRows = (await tx.execute(sql`
        select vault.create_secret(
          ${serialized},
          ${secretName},
          ${`Metal BYOK credentials for ${input.credential.provider}`}
        ) as id
      `)) as unknown as Array<{ id: string }>;
      const secretId = secretRows[0]?.id;
      if (!secretId) {
        throw new ApiError(500, "internal_error", "failed to encrypt provider credentials");
      }
      [credential] = await tx
        .insert(organizationProviderCredentials)
        .values({
          organizationId: input.organizationId,
          provider: input.credential.provider,
          secretId,
          createdBy: input.userId,
        })
        .returning();
      created = true;
    }

    if (!credential) {
      throw new ApiError(500, "internal_error", "failed to save provider credentials");
    }
    await tx.insert(domainEvents).values({
      type:
        created || existing?.disabledAt
          ? "organization.provider_credentials.configured"
          : "organization.provider_credentials.rotated",
      organizationId: input.organizationId,
      actorId: input.userId,
      payload: { provider: input.credential.provider },
    });
    return { credential, created };
  });
}

export async function removeOrganizationProviderCredential(
  db: MetalDb,
  input: {
    userId: string;
    organizationId: string;
    provider: ProviderCredentialInput["provider"];
  },
) {
  return withTransaction(db, async (tx) => {
    await requireMembership(tx, input.userId, input.organizationId, ["owner", "admin"]);
    const credential = await tx
      .select()
      .from(organizationProviderCredentials)
      .where(
        and(
          eq(organizationProviderCredentials.organizationId, input.organizationId),
          eq(organizationProviderCredentials.provider, input.provider),
          isNull(organizationProviderCredentials.disabledAt),
        ),
      )
      .then((rows) => rows[0]);
    if (!credential) {
      throw new ApiError(404, "not_found", "provider credentials are not configured");
    }

    const now = new Date();
    await tx
      .update(organizationProviderCredentials)
      .set({ disabledAt: now, updatedAt: now })
      .where(eq(organizationProviderCredentials.id, credential.id));
    await tx.insert(domainEvents).values({
      type: "organization.provider_credentials.removed",
      organizationId: input.organizationId,
      actorId: input.userId,
      payload: { provider: input.provider },
    });
    return credential;
  });
}
