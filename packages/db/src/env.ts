import { z } from "zod";

export const DatabaseEnvSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((value) => value.startsWith("postgres://") || value.startsWith("postgresql://"), {
      message: "DATABASE_URL must be a postgres connection string",
    }),
});
export type DatabaseEnv = z.infer<typeof DatabaseEnvSchema>;

export function loadDatabaseEnv(source: NodeJS.ProcessEnv = process.env): DatabaseEnv {
  return DatabaseEnvSchema.parse({
    DATABASE_URL: source.DATABASE_URL,
  });
}
