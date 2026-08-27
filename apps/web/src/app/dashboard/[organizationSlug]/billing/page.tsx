import { BillingView } from "@/components/billing-view";
import { requireOrganizationBySlug } from "@/lib/dashboard-organizations";
import { requireMetalSession } from "@/lib/metal-server";

export default async function OrganizationBillingPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationSlug: string }>;
  searchParams: Promise<{ checkout?: string; setup?: string }>;
}) {
  const { organizationSlug } = await params;
  const query = await searchParams;
  const organization = await requireOrganizationBySlug(organizationSlug);
  const { metal } = await requireMetalSession();
  const billing = await metal.billing.get(organization.id);
  const notice =
    query.checkout === "success"
      ? "Checkout completed. Credits appear after Stripe confirms the payment."
      : query.checkout === "cancel"
        ? "Checkout was canceled. No credits were added."
        : query.setup === "success"
          ? "Payment method setup completed. You can enable automatic top ups."
          : query.setup === "cancel"
            ? "Payment method setup was canceled."
            : null;

  return (
    <BillingView
      organizationId={organization.id}
      organizationName={organization.name}
      organizationSlug={organization.slug}
      initialBilling={billing}
      notice={notice}
    />
  );
}
