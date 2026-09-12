import { createOgImage } from "@/lib/og-image";
import { homeTitle, siteDescription } from "@/lib/site";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const title = searchParams.get("title")?.trim() || homeTitle();
  const description = searchParams.get("description")?.trim() || siteDescription;

  return createOgImage({ title, description });
}
