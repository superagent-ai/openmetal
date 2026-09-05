"use client";

import { useActionState } from "react";
import {
  updateOrganizationSettings,
  type UpdateOrganizationSettingsState,
} from "@/app/dashboard/[organizationSlug]/settings/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const initialState: UpdateOrganizationSettingsState = {};

export function OrganizationSettingsForm({
  organization,
  canManage,
}: {
  organization: {
    id: string;
    name: string;
    slug: string;
    createdAt: string;
  };
  canManage: boolean;
}) {
  const updateAction = updateOrganizationSettings.bind(null, organization.id, organization.slug);
  const [state, formAction, isPending] = useActionState(updateAction, initialState);
  const createdAt = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(organization.createdAt));

  return (
    <form action={formAction}>
      <FieldGroup>
        {!canManage ? (
          <Alert>
            <AlertDescription>
              Only organization owners and admins can change these details.
            </AlertDescription>
          </Alert>
        ) : null}
        {state.message ? (
          <Alert variant={state.status === "error" ? "destructive" : "default"} role="status">
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        ) : null}

        <Field data-invalid={Boolean(state.fieldErrors?.name)}>
          <FieldLabel htmlFor="organization-name">Organization name</FieldLabel>
          <Input
            id="organization-name"
            name="name"
            defaultValue={organization.name}
            autoComplete="organization"
            required
            maxLength={120}
            disabled={!canManage || isPending}
            aria-invalid={Boolean(state.fieldErrors?.name)}
            aria-describedby={
              state.fieldErrors?.name ? "organization-name-error" : "organization-name-description"
            }
          />
          <FieldDescription id="organization-name-description">
            This name appears throughout the dashboard and billing.
          </FieldDescription>
          <FieldError id="organization-name-error">{state.fieldErrors?.name}</FieldError>
        </Field>

        <Field data-invalid={Boolean(state.fieldErrors?.slug)}>
          <FieldLabel htmlFor="organization-slug">Organization slug</FieldLabel>
          <Input
            id="organization-slug"
            name="slug"
            defaultValue={organization.slug}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            maxLength={63}
            disabled={!canManage || isPending}
            aria-invalid={Boolean(state.fieldErrors?.slug)}
            aria-describedby={
              state.fieldErrors?.slug ? "organization-slug-error" : "organization-slug-description"
            }
          />
          <FieldDescription id="organization-slug-description">
            Used in dashboard URLs. Changing it makes the previous URL stop working.
          </FieldDescription>
          <FieldError id="organization-slug-error">{state.fieldErrors?.slug}</FieldError>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="organization-id">Organization ID</FieldLabel>
            <Input
              id="organization-id"
              value={organization.id}
              readOnly
              className="bg-muted/40 font-mono text-xs"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="organization-created">Created</FieldLabel>
            <Input id="organization-created" value={createdAt} readOnly className="bg-muted/40" />
          </Field>
        </div>

        {canManage ? (
          <Field>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Saving changes" : "Save changes"}
            </Button>
          </Field>
        ) : null}
      </FieldGroup>
    </form>
  );
}
