import path from "node:path";
import { readFile } from "node:fs/promises";
import { createOpenAPI } from "fumadocs-openapi/server";

const openApiPath = path.resolve(process.cwd(), "../../packages/contracts/openapi.json");

export const openapi = createOpenAPI({
  input: {
    metal: async () => {
      const document = JSON.parse(await readFile(openApiPath, "utf8"));
      document.servers = [
        {
          url: process.env.NEXT_PUBLIC_METAL_API_URL ?? "http://localhost:4000",
          description: "Metal API",
        },
      ];
      return document;
    },
  },
});
