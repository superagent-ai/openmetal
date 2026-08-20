import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument } from "./openapi.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "openapi.json"), `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
