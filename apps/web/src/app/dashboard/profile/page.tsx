import { ProfileSettingsForm } from "@/components/profile-settings-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentUser } from "@/lib/current-user";
import { resolveDisplayName } from "@/lib/user-profile";

export default async function ProfilePage() {
  const user = await getCurrentUser();
  const email = user.email ?? "";
  const displayName = resolveDisplayName(email, user.user_metadata);

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-balance">Profile</h1>
        <p className="mt-1 text-sm text-muted-foreground text-pretty">
          Manage how your account appears across Metal.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Profile information</CardTitle>
          <CardDescription>Update your display name and review your account email.</CardDescription>
        </CardHeader>
        <CardContent>
          <ProfileSettingsForm displayName={displayName} email={email} />
        </CardContent>
      </Card>
    </div>
  );
}
