import type { MetadataRoute } from "next";
import { absoluteUrl } from "@/lib/site";
import { source } from "@/lib/source";

export default function sitemap(): MetadataRoute.Sitemap {
  const documentation = source.getPages().map((page) => ({
    url: absoluteUrl(page.url),
    changeFrequency: "weekly" as const,
    priority: page.url === "/" ? 1 : page.url.startsWith("/api-reference") ? 0.5 : 0.7,
  }));

  return [
    ...documentation,
    {
      url: absoluteUrl("/login"),
      changeFrequency: "monthly",
      priority: 0.3,
    },
  ];
}
