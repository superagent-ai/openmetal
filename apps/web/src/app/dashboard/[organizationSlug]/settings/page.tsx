import type { Metadata } from "next";
import { DeleteOrganizationDialog } from "@/components/delete-organization-dialog";
import { OrganizationSettingsForm } from "@/components/organization-settings-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
    title: "Organization settings",
    description: `Manage the identity and lifecycle of ${organization.name}.`,
    path: `/dashboard/${organization.slug}/settings`,
  });
}

export default async function OrganizationSettingsPage({
  params,
}: {
  params: Promise<{ organizationSlug: string }>;
}) {
  const { organizationSlug } = await params;
  const organization = await requireOrganizationBySlug(organizationSlug);
  const { metal } = await requireMetalSession();
  const [members, billing] = await Promise.all([
    metal.members.list(organization.id),
    metal.billing.get(organization.id),
  ]);
  const canManage = members.viewer.role === "owner" || members.viewer.role === "admin";
  const canDelete = members.viewer.role === "owner";

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-balance">Organization settings</h1>
        <p className="mt-1 text-sm text-pretty text-muted-foreground">
          Manage the identity and lifecycle of {organization.name}.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
          <CardDescription>
            Update the name shown to members and the slug used in dashboard URLs.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OrganizationSettingsForm
            organization={{
              id: organization.id,
              name: organization.name,
              slug: organization.slug,
              createdAt: organization.created_at,
            }}
            canManage={canManage}
          />
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle>Danger zone</CardTitle>
          <CardDescription>
            Delete this organization and permanently remove member and API access.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canDelete ? (
            <DeleteOrganizationDialog
              organization={{ id: organization.id, name: organization.name }}
              balanceMicrousd={billing.balance_microusd}
              balanceUsd={billing.balance_usd}
            />
          ) : (
            <p className="shrink-0 text-sm text-muted-foreground">Owner access required</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
