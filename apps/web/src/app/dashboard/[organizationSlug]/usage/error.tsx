"use client";

import { useEffect } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export default function OrganizationUsageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Alert variant="destructive">
      <AlertTitle>Usage could not be loaded</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3">
        <span>Provider cost data is temporarily unavailable. Try loading the view again.</span>
        <Button type="button" variant="outline" size="sm" onClick={reset}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}
