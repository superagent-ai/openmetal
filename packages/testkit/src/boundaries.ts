import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export function assertWebUsesSdk(webRoot: string): void {
  const forbidden = [
    'from("organizations")',
    "from('organizations')",
    'from("projects")',
    "from('projects')",
    'from("domain_events")',
    "@openmetal/db",
    "DATABASE_URL",
    "SUPABASE_SECRET_KEY",
  ];
  const files = collectTsFiles(webRoot);
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    if (file.includes(`${join("lib", "metal")}`) || file.endsWith("metal.ts")) {
      continue;
    }
    if (source.includes("fetch(") && source.includes("/v1/")) {
      throw new Error(`${file} must not call the Metal API outside the SDK`);
    }
    for (const token of forbidden) {
      if (source.includes(token)) {
        throw new Error(`${file} contains forbidden boundary token: ${token}`);
      }
    }
  }
}

function collectTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".next" || entry === "e2e") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}
