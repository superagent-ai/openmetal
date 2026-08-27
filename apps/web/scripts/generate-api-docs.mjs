import { readFile } from "node:fs/promises";
import path from "node:path";
import { generateFiles } from "fumadocs-openapi";
import { createOpenAPI } from "fumadocs-openapi/server";

const schemaPath = path.resolve(process.cwd(), "../../packages/contracts/openapi.json");
const schema = JSON.parse(await readFile(schemaPath, "utf8"));

const openapi = createOpenAPI({
  input: {
    metal: schema,
  },
});

await generateFiles({
  input: openapi,
  output: "./content/docs/api-reference/endpoints",
  per: "operation",
  groupBy: "tag",
  includeDescription: true,
  meta: true,
});
