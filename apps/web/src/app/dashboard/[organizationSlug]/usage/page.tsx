import type { Metadata } from "next";
import { UsageView } from "@/components/usage-view";
import { requireOrganizationBySlug } from "@/lib/dashboard-organizations";
import { requireMetalSession } from "@/lib/metal-server";
import { dashboardPageMetadata } from "@/lib/page-metadata";
import { parseUsageFilters, usageQueryForFilters } from "@/lib/usage-filters";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ organizationSlug: string }>;
}): Promise<Metadata> {
  const { organizationSlug } = await params;
  const organization = await requireOrganizationBySlug(organizationSlug);
  return dashboardPageMetadata({
    title: "Usage",
    description: `Sandbox and compute usage for ${organization.name}.`,
    path: `/dashboard/${organization.slug}/usage`,
  });
}

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
