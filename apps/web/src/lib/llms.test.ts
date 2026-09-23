import type { Root } from "fumadocs-core/page-tree";
import { describe, expect, it } from "vitest";
import { buildLlmsTxt, openApiOperations, type LlmsPage } from "./llms";

const tree: Root = {
  name: "OpenMetal",
  children: [
    { type: "page", name: "Home", url: "/" },
    {
      type: "folder",
      name: "Guides",
      children: [
        { type: "page", name: "Create a sandbox", url: "/guides/create-sandbox" },
        {
          type: "folder",
          name: "Webhooks",
          index: { type: "page", name: "Receive webhooks", url: "/guides/webhooks" },
          children: [
            { type: "page", name: "Webhook event catalog", url: "/guides/webhooks/events" },
          ],
        },
      ],
    },
    {
      type: "folder",
      name: "API reference",
      index: { type: "page", name: "OpenMetal API", url: "/api-reference" },
      children: [
        {
          type: "folder",
          name: "Sandboxes",
          children: [
            {
              type: "page",
              name: "Create Sandbox",
              url: "/api-reference/endpoints/sandboxes/createSandbox",
            },
            {
              type: "page",
              name: "Get Sandbox",
              url: "/api-reference/endpoints/sandboxes/getSandbox",
            },
          ],
        },
      ],
    },
  ],
};

function page(url: string, title: string, description?: string): LlmsPage {
  const segments = url === "/" ? [] : url.slice(1).split("/");
  return {
    url,
    title,
    description,
    markdownUrl: `/llms.mdx/${[...segments, "content.md"].join("/")}`,
  };
}

const pages = [
  page("/", "Home", "Give your agent access to OpenMetal."),
  page("/guides/create-sandbox", "Create a sandbox", "Provision portable compute."),
  page("/guides/webhooks", "Receive webhooks", "Deliver signed lifecycle events."),
  page("/guides/webhooks/events", "Webhook event catalog"),
  page("/api-reference", "OpenMetal API", "Provision compute through the REST API."),
  page("/api-reference/endpoints/sandboxes/createSandbox", "Create Sandbox"),
  page("/api-reference/endpoints/sandboxes/getSandbox", "Get Sandbox"),
  page("/privacy", "Privacy Policy", "How OpenMetal handles personal information."),
];

const operations = openApiOperations({
  paths: {
    "/v1/sandboxes": {
      parameters: [],
      post: { operationId: "createSandbox" },
    },
    "/v1/sandboxes/{sandbox_id}": {
      get: { operationId: "getSandbox" },
    },
  },
});

const llmsTxt = buildLlmsTxt({
  origin: "https://www.openmetal.sh",
  apiUrl: "https://api.openmetal.sh",
  tree,
  pages,
  operations,
});

function section(title: string): string[] {
  const match = llmsTxt.split(/^## /m).find((block) => block.startsWith(`${title}\n`));
  return (match ?? "").split("\n").filter((line) => line.startsWith("- "));
}

describe("llms.txt", () => {
  it("indexes OpenAPI operations by operation ID", () => {
    expect(operations).toEqual(
      new Map([
        ["createSandbox", { method: "POST", path: "/v1/sandboxes" }],
        ["getSandbox", { method: "GET", path: "/v1/sandboxes/{sandbox_id}" }],
      ]),
    );
  });

  it("starts with an H1, a one line blockquote summary, and heading free notes", () => {
    const [title, blank, summary] = llmsTxt.split("\n");
    expect(title).toBe("# OpenMetal");
    expect(blank).toBe("");
    expect(summary).toMatch(/^> OpenMetal is the compute gateway for AI agents\. .+\.$/);

    const notes = llmsTxt.slice(0, llmsTxt.indexOf("\n## ")).split("\n").slice(3);
    expect(notes.some((line) => line.startsWith("#"))).toBe(false);
    expect(notes).toContain(
      "- The REST API base URL is `https://api.openmetal.sh`. Versioned routes are under `/v1`.",
    );
    expect(notes.join("\n")).toContain("https://www.openmetal.sh/llms-full.txt");
  });

  it("lists each documentation section as an H2 file list with absolute Markdown links", () => {
    expect(llmsTxt.match(/^## .+$/gm)).toEqual(["## Guides", "## API reference", "## Optional"]);
    expect(section("Guides")).toEqual([
      "- [Create a sandbox](https://www.openmetal.sh/llms.mdx/guides/create-sandbox/content.md): Provision portable compute.",
      "- [Receive webhooks](https://www.openmetal.sh/llms.mdx/guides/webhooks/content.md): Deliver signed lifecycle events.",
      "- [Webhook event catalog](https://www.openmetal.sh/llms.mdx/guides/webhooks/events/content.md)",
    ]);
  });

  it("links the OpenAPI document and moves endpoint pages with their routes to Optional", () => {
    expect(section("API reference")).toEqual([
      "- [OpenMetal API](https://www.openmetal.sh/llms.mdx/api-reference/content.md): Provision compute through the REST API.",
      "- [OpenAPI specification](https://api.openmetal.sh/v1/openapi.json): Machine-readable OpenAPI 3.1 document with every route, schema, and error.",
    ]);
    expect(section("Optional")).toEqual([
      "- [Create Sandbox](https://www.openmetal.sh/api-reference/endpoints/sandboxes/createSandbox): `POST /v1/sandboxes`",
      "- [Get Sandbox](https://www.openmetal.sh/api-reference/endpoints/sandboxes/getSandbox): `GET /v1/sandboxes/{sandbox_id}`",
      "- [Privacy Policy](https://www.openmetal.sh/llms.mdx/privacy/content.md): How OpenMetal handles personal information.",
    ]);
  });

  it("leaves the home page out and ends with the Optional section", () => {
    expect(llmsTxt).not.toContain("[Home]");
    expect(llmsTxt.trimEnd().split("\n## ").at(-1)).toMatch(/^Optional\n/);
    expect(llmsTxt.endsWith("\n")).toBe(true);
  });

  it("escapes Markdown link syntax in titles and URLs", () => {
    const escaped = buildLlmsTxt({
      origin: "https://www.openmetal.sh",
      apiUrl: "https://api.openmetal.sh",
      tree: { name: "OpenMetal", children: [] },
      pages: [page("/notes/(draft)", "Notes [beta]")],
      operations: new Map(),
    });

    expect(escaped).toContain(
      "- [Notes \\[beta\\]](https://www.openmetal.sh/llms.mdx/notes/\\(draft\\)/content.md)",
    );
  });
});
