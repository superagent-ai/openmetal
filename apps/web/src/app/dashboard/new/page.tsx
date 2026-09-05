import { NewOrganizationForm } from "@/components/new-organization-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function NewOrganizationPage() {
  return (
    <Card className="mx-auto w-full max-w-lg">
      <CardHeader>
        <CardTitle>
          <h1 className="text-2xl font-semibold">Create organization</h1>
        </CardTitle>
        <CardDescription>
          Organizations hold members, projects, settings, and credits. Your first organization
          receives $500.00 in welcome credits.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <NewOrganizationForm />
      </CardContent>
    </Card>
  );
}
