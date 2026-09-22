import { createOgImage, ogImageContentType, ogImageSize } from "@/lib/og-image";

export const alt = "OpenMetal — The Compute Gateway for AI Agents";
export const size = ogImageSize;
export const contentType = ogImageContentType;
export const runtime = "nodejs";

export default async function Image() {
  return createOgImage({
    title: "OpenMetal",
    description: "The Compute Gateway for AI Agents",
  });
}
