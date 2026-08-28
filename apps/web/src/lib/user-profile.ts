type UserMetadata = Record<string, unknown> | null | undefined;

const metadataNameKeys = ["display_name", "full_name", "name", "user_name"] as const;

export function resolveDisplayName(email: string, metadata?: UserMetadata): string {
  for (const key of metadataNameKeys) {
    const value = metadata?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  const emailName = email.split("@")[0]?.trim();
  return emailName || "Account";
}

export function resolveInitials(name: string): string {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  return initials || "A";
}
