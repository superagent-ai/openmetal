import { createOgImage, ogImageContentType, ogImageSize } from "@/lib/og-image";

export const alt = "Sign in to OpenMetal";
export const size = ogImageSize;
export const contentType = ogImageContentType;
export const runtime = "nodejs";

export default async function Image() {
  return createOgImage({
    title: "Sign in",
    description: "Continue with Google or GitHub, or email a magic link to access OpenMetal.",
  });
}
