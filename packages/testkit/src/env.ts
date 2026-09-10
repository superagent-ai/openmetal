import { z } from "zod";
import { loadRootEnv } from "./load-root-env.js";

loadRootEnv();

export const TestEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  SUPABASE_URL: z.string().url(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SECRET_KEY: z.string().min(1),
  METAL_API_URL: z.string().url().default("http://127.0.0.1:4000"),
});
export type TestEnv = z.infer<typeof TestEnvSchema>;

export function loadTestEnv(source: NodeJS.ProcessEnv = process.env): TestEnv {
  return TestEnvSchema.parse({
    DATABASE_URL: source.DATABASE_URL,
    SUPABASE_URL: source.SUPABASE_URL ?? source.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY:
      source.SUPABASE_PUBLISHABLE_KEY ?? source.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    SUPABASE_SECRET_KEY: source.SUPABASE_SECRET_KEY,
    METAL_API_URL: source.METAL_API_URL ?? source.NEXT_PUBLIC_METAL_API_URL,
  });
}
