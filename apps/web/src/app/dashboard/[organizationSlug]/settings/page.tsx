import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireOrganizationBySlug } from "@/lib/dashboard-organizations";
import { createClient } from "@/lib/supabase/server";

export default async function OrganizationSettingsPage({
  params,
}: {
  params: Promise<{ organizationSlug: string }>;
}) {
  const { organizationSlug } = await params;
  const organization = await requireOrganizationBySlug(organizationSlug);
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const email = typeof data?.claims?.email === "string" ? data.claims.email : "Unknown";

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage {organization.name}, your account preferences, and product resources.
        </p>
      </div>

      <Card id="profile" className="scroll-mt-16">
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>Your identity is managed by Supabase Auth.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Signed in as {email}</p>
        </CardContent>
      </Card>

      <Card id="preferences" className="scroll-mt-16">
        <CardHeader>
          <CardTitle>Preferences</CardTitle>
          <CardDescription>
            Appearance is available from the account menu. Organization preferences will appear
            here.
          </CardDescription>
        </CardHeader>
        <CardContent />
      </Card>

      <Card id="support" className="scroll-mt-16">
        <CardHeader>
          <CardTitle>Help & Support</CardTitle>
          <CardDescription>
            The private beta support channel is not configured yet. Contact your project
            administrator for assistance.
          </CardDescription>
        </CardHeader>
        <CardContent />
      </Card>

      <Card id="api-reference" className="scroll-mt-16">
        <CardHeader>
          <CardTitle>API Reference</CardTitle>
          <CardDescription>
            Explore the generated OpenAPI 3.1 reference, request schemas, and interactive examples.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button nativeButton={false} render={<Link href="/api-reference" />} variant="outline">
            Open API reference
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
