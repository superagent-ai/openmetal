import { createBrowserClient } from "@supabase/ssr";

export function createClient(options?: { isSingleton?: boolean }) {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { isSingleton: options?.isSingleton },
  );
}
