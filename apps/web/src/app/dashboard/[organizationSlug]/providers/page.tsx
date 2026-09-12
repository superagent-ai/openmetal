import type { Metadata } from "next";
import { ProviderCredentialsView } from "@/components/provider-credentials-view";
import { requireOrganizationBySlug } from "@/lib/dashboard-organizations";
import { requireMetalSession } from "@/lib/metal-server";
import { dashboardPageMetadata } from "@/lib/page-metadata";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ organizationSlug: string }>;
}): Promise<Metadata> {
  const { organizationSlug } = await params;
  const organization = await requireOrganizationBySlug(organizationSlug);
  return dashboardPageMetadata({
    title: "BYOK",
    description: `Bring your own provider credentials for ${organization.name}.`,
    path: `/dashboard/${organization.slug}/providers`,
  });
}

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
