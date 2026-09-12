import type { Metadata } from "next";
import Link from "next/link";
import { pageMetadata } from "@/lib/page-metadata";

export const metadata: Metadata = pageMetadata({
  title: "Page not found",
  description: "This page does not exist on OpenMetal.",
  path: "/",
  index: false,
});

export default function NotFound() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-3xl font-semibold text-balance">Page not found</h1>
      <p className="max-w-md text-pretty text-muted-foreground">
        The page you requested is not part of OpenMetal. Return home to browse the docs.
      </p>
      <Link href="/" className="text-sm font-semibold underline-offset-4 hover:underline">
        Back to OpenMetal
      </Link>
    </main>
  );
}
