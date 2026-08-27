import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const target = process.env.OPENMETAL_BUILD_TARGET;
const version = (process.env.OPENMETAL_CLI_VERSION ?? "0.1.0-dev").replace(/^cli-v/, "");
const commit = process.env.OPENMETAL_BUILD_COMMIT ?? "development";
const outfile = resolve(process.env.OPENMETAL_BUILD_OUTFILE ?? "dist/openmetal");

await mkdir(dirname(outfile), { recursive: true });

const result = await globalThis.Bun.build({
  entrypoints: [resolve("src/index.ts")],
  target: "bun",
  minify: true,
  sourcemap: "none",
  compile: {
    ...(target ? { target } : {}),
    outfile,
  },
  define: {
    __OPENMETAL_VERSION__: JSON.stringify(version),
    __OPENMETAL_COMMIT__: JSON.stringify(commit),
    __OPENMETAL_DEFAULT_API_URL__: JSON.stringify(
      process.env.OPENMETAL_DEFAULT_API_URL || "http://127.0.0.1:4000",
    ),
    __OPENMETAL_DEFAULT_SUPABASE_URL__: JSON.stringify(
      process.env.OPENMETAL_DEFAULT_SUPABASE_URL ?? "",
    ),
    __OPENMETAL_DEFAULT_SUPABASE_KEY__: JSON.stringify(
      process.env.OPENMETAL_DEFAULT_SUPABASE_KEY ?? "",
    ),
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log(`Built ${outfile}${target ? ` for ${target}` : ""}`);
