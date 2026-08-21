import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireOrganizationBySlug } from "@/lib/dashboard-organizations";

export default async function OrganizationUsagePage({
  params,
}: {
  params: Promise<{ organizationSlug: string }>;
}) {
  const { organizationSlug } = await params;
  const organization = await requireOrganizationBySlug(organizationSlug);

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Usage</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Review compute usage and provider costs for {organization.name}.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Organization usage</CardTitle>
          <CardDescription>Consolidated usage across projects will appear here.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Current resource costs are available from each project&apos;s Resources table.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
