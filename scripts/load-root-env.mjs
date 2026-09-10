import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadEnv } from "@dotenvx/dotenvx";

export function repoRoot() {
  return resolve(import.meta.dirname, "..");
}

export function loadRootEnv() {
  const root = repoRoot();
  const files = [".env.local", ".env"]
    .map((name) => resolve(root, name))
    .filter((file) => existsSync(file));

  if (files.length > 0) {
    loadEnv({ path: files, quiet: true });
  }

  return root;
}
