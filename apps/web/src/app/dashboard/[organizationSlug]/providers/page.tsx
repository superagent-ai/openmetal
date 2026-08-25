import { ProviderCredentialsView } from "@/components/provider-credentials-view";
import { requireOrganizationBySlug } from "@/lib/dashboard-organizations";
import { requireMetalSession } from "@/lib/metal-server";

export default async function OrganizationProvidersPage({
  params,
}: {
  params: Promise<{ organizationSlug: string }>;
}) {
  const { organizationSlug } = await params;
  const organization = await requireOrganizationBySlug(organizationSlug);
  const { metal } = await requireMetalSession();
  const { provider_credentials: providerCredentials } = await metal.providerCredentials.list(
    organization.id,
  );

  return (
    <ProviderCredentialsView
      organizationId={organization.id}
      organizationName={organization.name}
      initialCredentials={providerCredentials}
    />
  );
}
