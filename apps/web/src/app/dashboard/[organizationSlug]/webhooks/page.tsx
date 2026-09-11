import { EventTypeValues } from "@openmetal/events";
import { WebhooksView } from "@/components/webhooks-view";
import { requireOrganizationBySlug } from "@/lib/dashboard-organizations";
import { requireMetalSession } from "@/lib/metal-server";

export default async function OrganizationWebhooksPage({
  params,
}: {
  params: Promise<{ organizationSlug: string }>;
}) {
  const { organizationSlug } = await params;
  const organization = await requireOrganizationBySlug(organizationSlug);
  const { metal } = await requireMetalSession();
  const { webhooks } = await metal.webhooks.list(organization.id);

  return (
    <WebhooksView
      organizationId={organization.id}
      organizationName={organization.name}
      initialEndpoints={webhooks}
      eventCatalog={[...EventTypeValues]}
    />
  );
}
