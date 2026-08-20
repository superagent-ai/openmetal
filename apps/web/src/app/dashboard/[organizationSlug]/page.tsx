import { ControlPlane } from "@/components/control-plane";
import { requireOrganizationBySlug } from "@/lib/dashboard-organizations";

export default async function OrganizationDashboardPage({
  params,
}: {
  params: Promise<{ organizationSlug: string }>;
}) {
  const { organizationSlug } = await params;
  const organization = await requireOrganizationBySlug(organizationSlug);
  return <ControlPlane key={organization.id} organization={organization} />;
}
