import { flattenTree, type Folder, type Root } from "fumadocs-core/page-tree";

export const apiEndpointPathPrefix = "/api-reference/endpoints/";

export type LlmsPage = {
  url: string;
  title: string;
  description?: string;
  markdownUrl: string;
};

export type ApiOperation = {
  method: string;
  path: string;
};

export type LlmsTxtInput = {
  origin: string;
  apiUrl: string;
  tree: Root;
  pages: LlmsPage[];
  operations: ReadonlyMap<string, ApiOperation>;
};

type LlmsLink = {
  title: string;
  url: string;
  notes?: string;
};

type LlmsSection = {
  title: string;
  links: LlmsLink[];
};

type OpenApiDocument = {
  paths?: Record<string, Record<string, unknown>>;
};

export function openApiOperations(document: OpenApiDocument): Map<string, ApiOperation> {
  const operations = new Map<string, ApiOperation>();
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(item)) {
      const operationId = (operation as { operationId?: unknown } | null)?.operationId;
      if (typeof operationId === "string") {
        operations.set(operationId, { method: method.toUpperCase(), path });
      }
    }
  }
  return operations;
}

/**
 * Renders `/llms.txt` in the https://llmstxt.org format: an H1, a one line blockquote summary,
 * heading-free notes, H2 file lists, and a final `Optional` list that readers may skip.
 */
export function buildLlmsTxt({ origin, apiUrl, tree, pages, operations }: LlmsTxtInput): string {
  const absolute = (path: string) => new URL(path, origin).toString();
  const pagesByUrl = new Map(pages.map((page) => [page.url, page]));
  // The home page is layout markup; this file replaces it as the entry point for LLMs.
  const listed = new Set(["/"]);
  const optional: LlmsLink[] = [];

  const isEndpoint = (page: LlmsPage) => page.url.startsWith(apiEndpointPathPrefix);

  // Generated endpoint pages have no Markdown body, so they link to the rendered reference.
  const pageLink = (page: LlmsPage): LlmsLink => {
    if (!isEndpoint(page)) {
      return { title: page.title, url: absolute(page.markdownUrl), notes: page.description };
    }
    const operation = operations.get(page.url.split("/").at(-1) ?? "");
    return {
      title: page.title,
      url: absolute(page.url),
      notes: operation ? `\`${operation.method} ${operation.path}\`` : page.description,
    };
  };

  const sections = tree.children
    .filter((node): node is Folder => node.type === "folder")
    .map((folder): LlmsSection => {
      const links: LlmsLink[] = [];
      let hasEndpoints = false;

      for (const item of flattenTree([folder])) {
        const page = pagesByUrl.get(item.url);
        if (!page || listed.has(page.url)) continue;
        listed.add(page.url);

        if (isEndpoint(page)) {
          hasEndpoints = true;
          optional.push(pageLink(page));
        } else {
          links.push(pageLink(page));
        }
      }

      if (hasEndpoints) {
        links.push({
          title: "OpenAPI specification",
          url: new URL("/v1/openapi.json", apiUrl).toString(),
          notes: "Machine-readable OpenAPI 3.1 document with every route, schema, and error.",
        });
      }

      return { title: typeof folder.name === "string" ? folder.name : "", links };
    });

  for (const page of pages) {
    if (!listed.has(page.url)) optional.push(pageLink(page));
  }

  return renderLlmsTxt({
    title: "OpenMetal",
    summary:
      "OpenMetal is the compute gateway for AI agents. One REST API, TypeScript SDK, CLI, and Agent Skill provision and manage CPU sandboxes across Blaxel, Cloudflare, CodeSandbox, Daytona, E2B, Freestyle, Modal, Northflank, Runloop, and Vercel, with capability-based routing, project-scoped API keys, and one prepaid organization balance.",
    notes: `Important notes:

- The REST API base URL is \`${apiUrl}\`. Versioned routes are under \`/v1\`.
- Sandbox, operation, process, file, and HTTP endpoint routes use a project API key. Send \`Authorization: Bearer metal_sk_...\` and \`X-Metal-Project-ID: prj_...\`.
- Organization, member, project, API key, provider credential, billing, usage, and webhook management use a user access token. The two credential types are not interchangeable.
- Lifecycle and runtime mutations can return \`202 Accepted\` before provider work finishes. Persist the operation ID and wait until the operation is \`succeeded\`, \`failed\`, or \`cancelled\`.
- After an uncertain network result, retry a mutation with the same \`Idempotency-Key\` and identical input. Reusing a key with different input returns \`idempotency_mismatch\`.
- OpenMetal provides sandbox lifecycle, argv-based processes, binary file operations, and time-limited HTTP endpoints. It does not provide interactive terminals, streaming stdin, SSH, WebSocket, or a general connection API. Runtime support varies by provider.
- CPU sandboxes are available now. GPU workloads, browser computers, and persistent machines are planned but not available yet.
- Install the Agent Skill with \`npx skills add superagent-ai/openmetal --skill openmetal\`, the CLI with \`npm install --global @openmetal/cli\`, and the TypeScript SDK with \`npm install @openmetal/sdk\`.
- Never print API keys or place them in sandbox metadata, environment values, or process arguments.

Documentation links below point to Markdown versions of each page. API endpoint links open the rendered API reference. The complete documentation is also available as one file at ${absolute("/llms-full.txt")}.`,
    sections: [...sections, { title: "Optional", links: optional }],
  });
}

function renderLlmsTxt({
  title,
  summary,
  notes,
  sections,
}: {
  title: string;
  summary: string;
  notes: string;
  sections: LlmsSection[];
}): string {
  const blocks = [`# ${title}`, `> ${summary}`, notes];
  for (const section of sections) {
    if (section.links.length === 0) continue;
    blocks.push([`## ${section.title}`, "", ...section.links.map(renderLink)].join("\n"));
  }
  return `${blocks.join("\n\n")}\n`;
}

function renderLink({ title, url, notes }: LlmsLink): string {
  const link = `[${title.replace(/([[\]])/g, "\\$1")}](${url.replace(/([()])/g, "\\$1")})`;
  const description = notes?.trim();
  return description ? `- ${link}: ${description}` : `- ${link}`;
}
