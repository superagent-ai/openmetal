import type { Metadata } from "next";
import { DashboardOverview } from "@/components/dashboard-overview";
import { requireOrganizationBySlug } from "@/lib/dashboard-organizations";
import { listAllProjectGpuJobs } from "@/lib/gpu-jobs";
import { requireMetalSession } from "@/lib/metal-server";
import { dashboardPageMetadata } from "@/lib/page-metadata";
import { usageQueryForFilters } from "@/lib/usage-filters";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ organizationSlug: string }>;
}): Promise<Metadata> {
  const { organizationSlug } = await params;
  const organization = await requireOrganizationBySlug(organizationSlug);
  return dashboardPageMetadata({
    title: organization.name,
    description: `Overview of projects, usage, and credits for ${organization.name}.`,
    path: `/dashboard/${organization.slug}`,
  });
}

export default async function OrganizationDashboardPage({
  params,
}: {
  params: Promise<{ organizationSlug: string }>;
}) {
  const { organizationSlug } = await params;
  const organization = await requireOrganizationBySlug(organizationSlug);
  const { metal } = await requireMetalSession();
  const [projectResponse, usage, billing] = await Promise.all([
    metal.projects.list(organization.id),
    metal.usage.get(
      organization.id,
      usageQueryForFilters({ range: "this_week", billingMode: "all" }),
    ),
    metal.billing.get(organization.id),
  ]);
  const [sandboxResponses, gpuJobLists] = await Promise.all([
    Promise.all(projectResponse.projects.map((project) => metal.sandboxes.list(project.id))),
    Promise.all(
      projectResponse.projects.map((project) => listAllProjectGpuJobs(metal, project.id)),
    ),
  ]);
  const resources = [
    ...sandboxResponses.flatMap((response) => response.sandboxes),
    ...gpuJobLists.flatMap((list) => list.gpuJobs),
  ].map(({ id, state, created_at }) => ({ id, state, created_at }));
  const resourcesTruncated = gpuJobLists.some((list) => list.truncated);

  return (
    <DashboardOverview
      organization={organization}
      projectIds={projectResponse.projects.map((project) => project.id)}
      resources={resources}
      resourcesTruncated={resourcesTruncated}
      usage={usage}
      billing={billing}
    />
  );
}
