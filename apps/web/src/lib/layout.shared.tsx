import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { DocsNavbar } from "@/components/docs-navbar";
import { OpenMetalLogo } from "@/components/openmetal-logo";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <OpenMetalLogo />,
      component: <DocsNavbar />,
    },
  };
}
