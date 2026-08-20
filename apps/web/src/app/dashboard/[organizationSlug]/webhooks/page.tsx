import { UnavailableFeature } from "@/components/unavailable-feature";
import { requireOrganizationBySlug } from "@/lib/dashboard-organizations";

export default async function WebhooksPage({
  params,
}: {
  params: Promise<{ organizationSlug: string }>;
}) {
  const { organizationSlug } = await params;
  const organization = await requireOrganizationBySlug(organizationSlug);

  return (
    <UnavailableFeature
      title="Webhooks"
      organizationName={organization.name}
      description="Webhook endpoints, signing secrets, delivery history, and retries are not part of the current milestone."
    />
  );
}
