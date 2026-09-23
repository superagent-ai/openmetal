import { siteOrigin } from "@/lib/auth-redirect";
import { buildLlmsTxt, openApiOperations } from "@/lib/llms";
import { metalApiUrl, readOpenApiDocument } from "@/lib/openapi";
import { getPageMarkdownUrl, source } from "@/lib/source";

export const revalidate = false;

export async function GET() {
  const body = buildLlmsTxt({
    origin: siteOrigin(),
    apiUrl: metalApiUrl(),
    tree: source.getPageTree(),
    pages: source.getPages().map((page) => ({
      url: page.url,
      title: page.data.title,
      description: page.data.description,
      markdownUrl: getPageMarkdownUrl(page).url,
    })),
    operations: openApiOperations(await readOpenApiDocument()),
  });

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
