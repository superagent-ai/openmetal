"use client";

import { useState } from "react";
import { deleteOrganization } from "@/app/dashboard/[organizationSlug]/settings/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export function DeleteOrganizationDialog({
  organization,
  balanceMicrousd,
  balanceUsd,
}: {
  organization: { id: string; name: string };
  balanceMicrousd: string;
  balanceUsd: string;
}) {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [forfeitBalance, setForfeitBalance] = useState(false);
  const [error, setError] = useState<string>();
  const [isDeleting, setIsDeleting] = useState(false);
  const hasBalance = BigInt(balanceMicrousd) > 0n;
  const canDelete =
    confirmation === organization.name && (!hasBalance || forfeitBalance) && !isDeleting;

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      setConfirmation("");
      setForfeitBalance(false);
      setError(undefined);
    }
  }

  async function handleDelete() {
    if (!canDelete) return;
    setError(undefined);
    setIsDeleting(true);
    const result = await deleteOrganization({
      organizationId: organization.id,
      confirmName: confirmation,
      confirmForfeitBalance: forfeitBalance,
    });
    if (result.error) {
      setError(result.error);
      setIsDeleting(false);
    }
  }

  return (
    <>
      <Button type="button" variant="destructive" className="w-full" onClick={() => setOpen(true)}>
        Delete organization
      </Button>
      <AlertDialog open={open} onOpenChange={handleOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {organization.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes member and API access. Billing and audit records are
              retained. Stop all active resources before continuing.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <Field>
            <FieldLabel htmlFor="delete-organization-confirmation">
              Type {organization.name} to confirm
            </FieldLabel>
            <Input
              id="delete-organization-confirmation"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
              disabled={isDeleting}
            />
          </Field>

          {hasBalance ? (
            <Field>
              <label
                htmlFor="forfeit-organization-balance"
                className="flex items-start gap-3 text-sm"
              >
                <input
                  id="forfeit-organization-balance"
                  type="checkbox"
                  checked={forfeitBalance}
                  onChange={(event) => setForfeitBalance(event.target.checked)}
                  disabled={isDeleting}
                  className="mt-1 size-4 accent-destructive"
                />
                <span>Forfeit the remaining ${balanceUsd} credit balance.</span>
              </label>
              <FieldDescription>
                Remaining credits cannot be transferred or restored after deletion.
              </FieldDescription>
            </Field>
          ) : null}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={!canDelete}
              onClick={() => void handleDelete()}
            >
              {isDeleting ? "Deleting organization" : "Delete organization"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
