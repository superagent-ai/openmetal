import type { Metadata } from "next";
import { ApiKeysView } from "@/components/api-keys-view";
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
    title: "API keys",
    description: `Create and revoke project API keys for ${organization.name}.`,
    path: `/dashboard/${organization.slug}/api-keys`,
  });
}

export default async function OrganizationApiKeysPage({
  params,
}: {
  params: Promise<{ organizationSlug: string }>;
}) {
  const { organizationSlug } = await params;
  const organization = await requireOrganizationBySlug(organizationSlug);
  const { metal } = await requireMetalSession();
  const { projects } = await metal.projects.list(organization.id);
  const apiKeys = (
    await Promise.all(
      projects.map(async (project) => {
        const result = await metal.apiKeys.list(project.id);
        return result.api_keys;
      }),
    )
  ).flat();

  return (
    <ApiKeysView
      organizationName={organization.name}
      projects={projects}
      initialApiKeys={apiKeys}
    />
  );
}
