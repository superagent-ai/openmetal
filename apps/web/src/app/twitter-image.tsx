import { createOgImage, ogImageContentType, ogImageSize } from "@/lib/og-image";

export const alt = "OpenMetal — Unified computer for AI Agents";
export const size = ogImageSize;
export const contentType = ogImageContentType;
export const runtime = "nodejs";

export default async function Image() {
  return createOgImage({
    title: "OpenMetal",
    description: "Unified computer for AI Agents",
  });
}
