import type { ProviderCreateSandboxInput, SandboxProvider } from "@openmetal/provider-core";

export async function exerciseSandboxProvider(
  provider: SandboxProvider,
  input: ProviderCreateSandboxInput,
) {
  const created = await provider.create(input);
  const duplicate = await provider.create(input);
  if (duplicate.providerResourceId !== created.providerResourceId) {
    throw new Error("provider create is not idempotent by Metal sandbox ID");
  }
  if (provider.capabilities.pause) {
    await provider.pause(created.providerResourceId);
    if (provider.capabilities.resume && provider.resume) {
      await provider.resume(created.providerResourceId);
    }
  }
  const now = new Date();
  const cost = provider.capabilities.cost
    ? await provider.getCost({
        providerResourceId: created.providerResourceId,
        providerOrganizationId: created.providerOrganizationId,
        providerMetadata: created.providerMetadata,
        from: new Date(now.getTime() - 1_000),
        to: now,
      })
    : null;
  await provider.destroy(created.providerResourceId);
  await provider.destroy(created.providerResourceId);
  return { created, cost };
}
