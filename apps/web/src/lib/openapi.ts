import path from "node:path";
import { readFile } from "node:fs/promises";
import { createOpenAPI } from "fumadocs-openapi/server";

const openApiPath = path.resolve(process.cwd(), "../../packages/contracts/openapi.json");
const defaultMetalApiUrl = "https://api.openmetal.sh";

export function metalApiUrl(): string {
  return process.env.NEXT_PUBLIC_METAL_API_URL ?? process.env.METAL_API_URL ?? defaultMetalApiUrl;
}

export async function readOpenApiDocument() {
  return JSON.parse(await readFile(openApiPath, "utf8"));
}

export const openapi = createOpenAPI({
  input: {
    metal: async () => {
      const document = await readOpenApiDocument();
      document.servers = [
        {
          url: metalApiUrl(),
          description: "OpenMetal API",
        },
      ];
      return document;
    },
  },
});
