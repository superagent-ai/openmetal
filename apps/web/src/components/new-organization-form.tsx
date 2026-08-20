"use client";

import { useActionState } from "react";
import { createOrganization, type CreateOrganizationState } from "@/app/dashboard/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const initialState: CreateOrganizationState = {};

export function NewOrganizationForm() {
  const [state, formAction, isPending] = useActionState(createOrganization, initialState);

  return (
    <form action={formAction}>
      <FieldGroup>
        {state.error ? (
          <Alert variant="destructive">
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        ) : null}
        <Field>
          <FieldLabel htmlFor="organization-name">Organization name</FieldLabel>
          <Input
            id="organization-name"
            name="name"
            placeholder="Engineering"
            autoComplete="organization"
            required
            maxLength={120}
          />
          <FieldDescription>
            A URL-safe organization slug is generated from this name.
          </FieldDescription>
        </Field>
        <Field>
          <Button type="submit" disabled={isPending}>
            {isPending ? "Creating organization" : "Create organization"}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}
