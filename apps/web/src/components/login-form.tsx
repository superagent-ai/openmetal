import { sendMagicLink } from "@/app/login/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function LoginForm({
  className,
  sent,
  error,
  ...props
}: React.ComponentProps<"form"> & {
  sent?: string;
  error?: string;
}) {
  return (
    <form action={sendMagicLink} className={cn("flex flex-col gap-6", className)} {...props}>
      <FieldGroup>
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-2xl font-semibold">Sign in to Metal</h1>
          <p className="text-sm text-balance text-muted-foreground">
            We will email you a magic link. Open it to confirm your session.
          </p>
        </div>
        {sent ? (
          <Alert>
            <AlertDescription>
              Check your inbox for the sign in link. Local mail is available in Inbucket.
            </AlertDescription>
          </Alert>
        ) : null}
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <Field>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input id="email" name="email" type="email" placeholder="you@company.com" required />
        </Field>
        <Field>
          <Button type="submit" className="w-full">
            Send magic link
          </Button>
          <FieldDescription className="text-center">
            New accounts are created when you confirm the email.
          </FieldDescription>
        </Field>
      </FieldGroup>
    </form>
  );
}
