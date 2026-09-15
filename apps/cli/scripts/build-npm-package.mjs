import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const rawVersion = process.env.OPENMETAL_CLI_VERSION ?? "0.1.0-dev";
const version = rawVersion.replace(/^cli-v/, "");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`OPENMETAL_CLI_VERSION must be a valid release version, received ${rawVersion}`);
}

const commit = process.env.OPENMETAL_BUILD_COMMIT ?? "development";
const outdir = resolve("dist/npm");
const outfile = resolve(outdir, "openmetal.js");
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const result = await globalThis.Bun.build({
  entrypoints: [resolve("src/index.ts")],
  outdir,
  naming: "openmetal.js",
  target: "node",
  format: "esm",
  packages: "bundle",
  minify: true,
  sourcemap: "none",
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

const bundled = await readFile(outfile, "utf8");
if (!bundled.startsWith("#!/usr/bin/env node")) {
  await writeFile(outfile, `#!/usr/bin/env node\n${bundled}`);
}
await chmod(outfile, 0o755);

const manifest = {
  name: "@openmetal/cli",
  version,
  description: "Command-line interface for the OpenMetal compute API",
  type: "module",
  bin: { openmetal: "./openmetal.js" },
  engines: { node: ">=22.0.0" },
  repository: {
    type: "git",
    url: "git+https://github.com/superagent-ai/openmetal.git",
    directory: "apps/cli",
  },
  homepage: "https://github.com/superagent-ai/openmetal#openmetal-cli",
  bugs: { url: "https://github.com/superagent-ai/openmetal/issues" },
  license: "MIT",
  publishConfig: {
    access: "public",
  },
};

await writeFile(resolve(outdir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await cp(resolve("../../docs/cli.md"), resolve(outdir, "README.md"));

console.log(`Built npm package @openmetal/cli@${version} in ${outdir}`);
