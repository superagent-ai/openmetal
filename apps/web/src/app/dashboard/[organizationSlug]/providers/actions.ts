"use server";

import type { ProviderCredentialInput } from "@openmetal/sdk";
import { requireMetalSession } from "@/lib/metal-server";

export async function configureProviderCredential(
  organizationId: string,
  credential: ProviderCredentialInput,
) {
  const { metal } = await requireMetalSession();
  return metal.providerCredentials.configure(organizationId, credential);
}

export async function removeProviderCredential(
  organizationId: string,
  provider: ProviderCredentialInput["provider"],
) {
  const { metal } = await requireMetalSession();
  return metal.providerCredentials.remove(organizationId, provider);
}
