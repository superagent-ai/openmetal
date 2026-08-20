import { UnavailableFeature } from "@/components/unavailable-feature";
import { requireOrganizationBySlug } from "@/lib/dashboard-organizations";

export default async function UsagePage({
  params,
}: {
  params: Promise<{ organizationSlug: string }>;
}) {
  const { organizationSlug } = await params;
  const organization = await requireOrganizationBySlug(organizationSlug);

  return (
    <UnavailableFeature
      title="Usage"
      organizationName={organization.name}
      description="Durable provider usage, normalized intervals, and customer-facing totals arrive with metering."
    />
  );
}
