import { ApiKeysView } from "@/components/api-keys-view";
import { requireOrganizationBySlug } from "@/lib/dashboard-organizations";
import { requireMetalSession } from "@/lib/metal-server";

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
