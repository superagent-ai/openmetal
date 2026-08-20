export function safeInternalPath(value: string | null | undefined, fallback: string): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return fallback;
  }

  try {
    const parsed = new URL(value, "http://metal.local");
    if (parsed.origin !== "http://metal.local") {
      return fallback;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
