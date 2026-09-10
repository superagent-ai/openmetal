import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config as loadEnv } from "@dotenvx/dotenvx";

function findRepoRoot(start: string): string {
  let dir = start;
  while (true) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return start;
    }
    dir = parent;
  }
}

export function loadRootEnv(): void {
  const root = findRepoRoot(import.meta.dirname);
  const files = [".env.local", ".env"]
    .map((name) => resolve(root, name))
    .filter((file) => existsSync(file));

  if (files.length > 0) {
    loadEnv({ path: files, quiet: true });
  }
}
