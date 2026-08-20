import { UnavailableFeature } from "@/components/unavailable-feature";
import { requireOrganizationBySlug } from "@/lib/dashboard-organizations";

export default async function BillingPage({
  params,
}: {
  params: Promise<{ organizationSlug: string }>;
}) {
  const { organizationSlug } = await params;
  const organization = await requireOrganizationBySlug(organizationSlug);

  return (
    <UnavailableFeature
      title="Billing"
      organizationName={organization.name}
      description="Funding, balances, charges, refunds, and reconciliation arrive with the metering and ledger milestone."
    />
  );
}
