import { UsageView } from "@/components/usage-view";
import { requireOrganizationBySlug } from "@/lib/dashboard-organizations";
import { requireMetalSession } from "@/lib/metal-server";
import { parseUsageFilters, usageQueryForFilters } from "@/lib/usage-filters";

export default async function OrganizationUsagePage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { organizationSlug } = await params;
  const query = await searchParams;
  const organization = await requireOrganizationBySlug(organizationSlug);
  const filters = parseUsageFilters(query);
  const { metal } = await requireMetalSession();
  const [usage, projectResponse] = await Promise.all([
    metal.usage.get(organization.id, usageQueryForFilters(filters)),
    metal.projects.list(organization.id),
  ]);

  return (
    <UsageView
      organizationSlug={organization.slug}
      usage={usage}
      projects={projectResponse.projects}
      filters={filters}
    />
  );
}
