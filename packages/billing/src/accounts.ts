import { eq, sql } from "drizzle-orm";
import { autoTopupPolicies, billingAccounts, organizations, type MetalDb } from "@openmetal/db";

export async function ensureBillingAccount(tx: MetalDb, organizationId: string) {
  await tx
    .insert(billingAccounts)
    .values({ organizationId })
    .onConflictDoNothing({ target: billingAccounts.organizationId });
  await tx
    .insert(autoTopupPolicies)
    .values({ organizationId })
    .onConflictDoNothing({ target: autoTopupPolicies.organizationId });
  await tx.execute(
    sql`select organization_id from metal.billing_accounts where organization_id = ${organizationId} for update`,
  );
  const [account] = await tx
    .select()
    .from(billingAccounts)
    .where(eq(billingAccounts.organizationId, organizationId));
  if (!account) {
    throw new Error("billing account not found");
  }
  return account;
}

export async function getOrganizationName(tx: MetalDb, organizationId: string): Promise<string> {
  const organization = await tx
    .select({ name: organizations.name, slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .then((rows) => rows[0]);
  if (!organization) {
    throw new Error("organization not found");
  }
  return organization.name;
}

export async function getOrganizationSlug(tx: MetalDb, organizationId: string): Promise<string> {
  const organization = await tx
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .then((rows) => rows[0]);
  if (!organization) {
    throw new Error("organization not found");
  }
  return organization.slug;
}
