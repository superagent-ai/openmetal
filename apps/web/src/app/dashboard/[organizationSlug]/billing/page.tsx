import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireOrganizationBySlug } from "@/lib/dashboard-organizations";

export default async function OrganizationBillingPage({
  params,
}: {
  params: Promise<{ organizationSlug: string }>;
}) {
  const { organizationSlug } = await params;
  const organization = await requireOrganizationBySlug(organizationSlug);

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Billing</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage billing and payment details for {organization.name}.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Organization billing</CardTitle>
          <CardDescription>
            Balance, payment methods, and invoices will appear here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Resource costs are currently available from each project&apos;s Resources table.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
