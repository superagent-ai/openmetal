import type { Metadata } from "next";
import { homeTitle, siteDescription, siteName } from "./site";

export type PageMetadataInput = {
  title: string;
  description: string;
  path: string;
  absoluteTitle?: boolean;
  image?: boolean;
  index?: boolean;
  type?: "website" | "article";
  alternates?: Metadata["alternates"];
};

const ogImageWidth = 1200;
const ogImageHeight = 630;

export function isHomePath(path: string): boolean {
  return path === "/";
}

export function resolvePageTitle(title: string, path: string): string {
  return isHomePath(path) ? homeTitle() : title;
}

export function resolvePageDescription(
  title: string,
  description: string | undefined,
  path: string,
): string {
  const trimmed = description?.trim();
  if (trimmed) {
    return trimmed;
  }
  if (isHomePath(path)) {
    return siteDescription;
  }
  if (path === "/api-reference" || path.startsWith("/api-reference/")) {
    return `${title} in the OpenMetal REST API.`;
  }
  return `${title} in the OpenMetal documentation.`;
}

export function brandedTitle(title: string, absoluteTitle?: boolean): string {
  if (absoluteTitle || title === homeTitle() || title.endsWith(` | ${siteName}`)) {
    return title;
  }
  return `${title} | ${siteName}`;
}

export function ogImagePath(title: string, description: string): string {
  const params = new URLSearchParams({ title, description });
  return `/api/og?${params.toString()}`;
}

function socialImage(title: string, description: string) {
  return {
    url: ogImagePath(title, description),
    width: ogImageWidth,
    height: ogImageHeight,
    alt: title.includes(siteName) ? title : `${title} — ${siteName}`,
  };
}

export function pageMetadata(input: PageMetadataInput): Metadata {
  const socialTitle = brandedTitle(input.title, input.absoluteTitle);
  const image = socialImage(input.title, input.description);
  const images = input.image === false ? undefined : [image];
  const index = input.index !== false;

  return {
    title: input.absoluteTitle ? { absolute: input.title } : input.title,
    description: input.description,
    alternates: {
      canonical: input.path,
      ...input.alternates,
    },
    openGraph: {
      title: socialTitle,
      description: input.description,
      url: input.path,
      siteName,
      locale: "en_US",
      type: input.type ?? "website",
      ...(images ? { images } : {}),
    },
    twitter: {
      card: "summary_large_image",
      title: socialTitle,
      description: input.description,
      ...(images ? { images } : {}),
    },
    robots: index
      ? {
          index: true,
          follow: true,
        }
      : {
          index: false,
          follow: false,
        },
  };
}

export function dashboardPageMetadata(input: Omit<PageMetadataInput, "index" | "type">): Metadata {
  return pageMetadata({ ...input, index: false });
}
