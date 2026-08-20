import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function UnavailableFeature({
  title,
  description,
  organizationName,
}: {
  title: string;
  description: string;
  organizationName: string;
}) {
  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{organizationName}</p>
      </div>
      <Card>
        <CardHeader>
          <div>
            <Badge variant="outline">Coming later</Badge>
          </div>
          <CardTitle>{title} is not available yet</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            This page is intentionally read-only until its backend milestone is complete.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
