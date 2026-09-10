import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dotenvxBin = resolve(root, "node_modules/.bin/dotenvx");
const files = [".env.local", ".env"].filter((name) => existsSync(resolve(root, name)));
const command = process.argv.slice(2);

if (command.length === 0) {
  throw new Error("usage: node scripts/dotenvx-run.mjs <command>...");
}

if (!existsSync(dotenvxBin)) {
  throw new Error("missing @dotenvx/dotenvx. Run pnpm install.");
}

const child = spawn(
  dotenvxBin,
  ["run", ...files.flatMap((file) => ["-f", file]), "--", ...command],
  {
    cwd: root,
    stdio: "inherit",
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
