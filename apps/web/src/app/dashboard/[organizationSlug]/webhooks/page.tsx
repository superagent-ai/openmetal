import type { Metadata } from "next";
import { EventTypeValues } from "@openmetal/events";
import { WebhooksView } from "@/components/webhooks-view";
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
    title: "Webhooks",
    description: `Deliver signed lifecycle events from ${organization.name}.`,
    path: `/dashboard/${organization.slug}/webhooks`,
  });
}

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
