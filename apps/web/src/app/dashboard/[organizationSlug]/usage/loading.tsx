import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function OrganizationUsageLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading organization usage">
      <div className="space-y-2">
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-5 w-96 max-w-full" />
      </div>
      <div className="flex flex-wrap justify-between gap-3">
        <Skeleton className="h-9 w-80 max-w-full" />
        <Skeleton className="h-9 w-64 max-w-full" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Card key={index} size="sm">
            <CardHeader>
              <Skeleton className="h-4 w-28" />
            </CardHeader>
            <CardContent className="space-y-2">
              <Skeleton className="h-8 w-24" />
              <Skeleton className="h-4 w-36" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-56" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[340px] w-full" />
        </CardContent>
      </Card>
    </div>
  );
}
