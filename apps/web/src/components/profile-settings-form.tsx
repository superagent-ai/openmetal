"use client";

import { useActionState } from "react";
import { updateProfile, type UpdateProfileState } from "@/app/dashboard/profile/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { resolveInitials } from "@/lib/user-profile";

const initialState: UpdateProfileState = {};

export function ProfileSettingsForm({
  displayName,
  email,
}: {
  displayName: string;
  email: string;
}) {
  const [state, formAction, isPending] = useActionState(updateProfile, initialState);

  return (
    <form action={formAction}>
      <FieldGroup>
        <div className="flex items-center gap-4">
          <Avatar className="size-16 rounded-xl after:rounded-xl">
            <AvatarFallback className="rounded-xl text-lg font-medium">
              {resolveInitials(displayName)}
            </AvatarFallback>
          </Avatar>
          <div>
            <p className="font-medium text-pretty">{displayName}</p>
            <p className="text-sm text-muted-foreground text-pretty">{email}</p>
          </div>
        </div>

        {state.message ? (
          <Alert variant={state.status === "error" ? "destructive" : "default"} role="status">
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        ) : null}

        <Field data-invalid={Boolean(state.fieldError)}>
          <FieldLabel htmlFor="display-name">Display name</FieldLabel>
          <Input
            id="display-name"
            name="displayName"
            defaultValue={displayName}
            autoComplete="name"
            required
            maxLength={80}
            aria-invalid={Boolean(state.fieldError)}
            aria-describedby={state.fieldError ? "display-name-error" : "display-name-description"}
          />
          <FieldDescription id="display-name-description">
            This name appears in your account menu.
          </FieldDescription>
          <FieldError id="display-name-error">{state.fieldError}</FieldError>
        </Field>

        <Field>
          <FieldLabel htmlFor="profile-email">Email</FieldLabel>
          <Input
            id="profile-email"
            type="email"
            value={email}
            readOnly
            aria-describedby="profile-email-description"
            className="bg-muted/40"
          />
          <FieldDescription id="profile-email-description">
            Your email is managed by your sign in provider.
          </FieldDescription>
        </Field>

        <Field>
          <Button type="submit" disabled={isPending}>
            {isPending ? "Saving changes" : "Save changes"}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}
