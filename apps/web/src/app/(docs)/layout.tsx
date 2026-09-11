import type { ReactNode } from "react";
import { DocsLayout } from "fumadocs-ui/layouts/notebook";
import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";

export default function DocumentationLayout({ children }: { children: ReactNode }) {
  const { nav, ...base } = baseOptions();

  return (
    <DocsLayout
      tree={source.getPageTree()}
      {...base}
      nav={{ ...nav, mode: "top" }}
      containerProps={{ className: "[--fd-layout-width:100vw]" }}
      sidebar={{
        className: "border-e border-border bg-background",
        defaultOpenLevel: 0,
        prefetch: false,
      }}
    >
      {children}
    </DocsLayout>
  );
}
