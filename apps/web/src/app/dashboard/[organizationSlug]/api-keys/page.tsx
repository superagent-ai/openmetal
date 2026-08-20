import { UnavailableFeature } from "@/components/unavailable-feature";
import { requireOrganizationBySlug } from "@/lib/dashboard-organizations";

export default async function ApiKeysPage({
  params,
}: {
  params: Promise<{ organizationSlug: string }>;
}) {
  const { organizationSlug } = await params;
  const organization = await requireOrganizationBySlug(organizationSlug);

  return (
    <UnavailableFeature
      title="API keys"
      organizationName={organization.name}
      description="Scoped API key creation, rotation, and revocation arrive with the identity and lifecycle milestone."
    />
  );
}
