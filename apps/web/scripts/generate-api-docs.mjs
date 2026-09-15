import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { generateFiles } from "fumadocs-openapi";
import { createOpenAPI } from "fumadocs-openapi/server";

const schemaPath = path.resolve(process.cwd(), "../../packages/contracts/openapi.json");
const outputPath = path.resolve(process.cwd(), "content/docs/api-reference/endpoints");
const schema = JSON.parse(await readFile(schemaPath, "utf8"));

const openapi = createOpenAPI({
  input: {
    metal: schema,
  },
});

await rm(outputPath, { recursive: true, force: true });

await generateFiles({
  input: openapi,
  output: outputPath,
  per: "operation",
  groupBy: "tag",
  includeDescription: true,
  meta: true,
});
