import path from "node:path";
import { readFile } from "node:fs/promises";
import { createOpenAPI } from "fumadocs-openapi/server";

const openApiPath = path.resolve(process.cwd(), "../../packages/contracts/openapi.json");
const defaultMetalApiUrl = "https://api.openmetal.sh";

export const openapi = createOpenAPI({
  input: {
    metal: async () => {
      const document = JSON.parse(await readFile(openApiPath, "utf8"));
      document.servers = [
        {
          url:
            process.env.NEXT_PUBLIC_METAL_API_URL ??
            process.env.METAL_API_URL ??
            defaultMetalApiUrl,
          description: "OpenMetal API",
        },
      ];
      return document;
    },
  },
});
