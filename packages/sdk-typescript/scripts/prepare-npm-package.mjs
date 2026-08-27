import { cp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const rawVersion = process.env.OPENMETAL_SDK_VERSION ?? "0.1.0-dev";
const version = rawVersion.replace(/^sdk-v/, "");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`OPENMETAL_SDK_VERSION must be a valid release version, received ${rawVersion}`);
}

const outdir = resolve("dist/npm");
const runtime = await readFile(resolve(outdir, "index.js"), "utf8");
const declarations = await readFile(resolve(outdir, "index.d.ts"), "utf8");
for (const [name, output] of [
  ["runtime", runtime],
  ["declarations", declarations],
]) {
  if (output.includes("@openmetal/contracts") || output.includes("workspace:*")) {
    throw new Error(`${name} output contains an unpublished workspace dependency`);
  }
}

const manifest = {
  name: "@openmetal/sdk",
  version,
  description: "TypeScript SDK for the OpenMetal compute API",
  type: "module",
  main: "./index.js",
  types: "./index.d.ts",
  exports: {
    ".": {
      types: "./index.d.ts",
      import: "./index.js",
    },
  },
  files: ["index.js", "index.d.ts", "README.md"],
  sideEffects: false,
  engines: { node: ">=22.0.0" },
  dependencies: {
    zod: "4.4.3",
  },
  repository: {
    type: "git",
    url: "git+https://github.com/homanp/metal.git",
    directory: "packages/sdk-typescript",
  },
  homepage: "https://github.com/homanp/metal#typescript-sdk",
  bugs: { url: "https://github.com/homanp/metal/issues" },
  license: "UNLICENSED",
  publishConfig: {
    access: "public",
  },
};

await writeFile(resolve(outdir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await cp(resolve("README.md"), resolve(outdir, "README.md"));

console.log(`Prepared npm package @openmetal/sdk@${version} in ${outdir}`);
