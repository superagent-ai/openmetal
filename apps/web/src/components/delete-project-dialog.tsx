"use client";

import { useState } from "react";
import { Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export function DeleteProjectDialog({
  project,
  onOpenChange,
  onDelete,
}: {
  project: { id: string; name: string };
  onOpenChange: (open: boolean) => void;
  onDelete: () => Promise<void>;
}) {
  const [error, setError] = useState<string>();
  const [isDeleting, setIsDeleting] = useState(false);

  async function handleDelete() {
    setError(undefined);
    setIsDeleting(true);
    try {
      await onDelete();
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete the project");
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <AlertDialog open onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
          </AlertDialogMedia>
          <AlertDialogTitle>Delete {project.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            The project will be removed from the organization. Its durable audit events are
            retained.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={isDeleting}
            onClick={() => void handleDelete()}
          >
            {isDeleting ? "Deleting" : "Delete project"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
