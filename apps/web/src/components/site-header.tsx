"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";

type Organization = {
  id: string;
  name: string;
  slug: string;
};

export function SiteHeader({
  organizations,
  preferredOrganizationId,
}: {
  organizations: Organization[];
  preferredOrganizationId?: string;
}) {
  const pathname = usePathname();
  const routeSlug = pathname.split("/")[2];
  const activeOrganization =
    organizations.find((organization) => organization.slug === routeSlug) ??
    organizations.find((organization) => organization.id === preferredOrganizationId) ??
    organizations[0];
  const pageTitles: Record<string, string> = {
    "api-keys": "API keys",
    billing: "Billing",
    projects: "Projects",
    settings: "Settings",
    usage: "Usage",
    webhooks: "Webhooks",
  };
  const lastSegment = pathname.split("/").at(-1) ?? "";
  const title =
    pathname === "/dashboard/new"
      ? "New organization"
      : pathname.includes("/projects")
        ? "Projects"
        : (pageTitles[lastSegment] ?? "Overview");
  const parentLabel = activeOrganization?.name ?? "Metal";
  const parentHref = activeOrganization ? `/dashboard/${activeOrganization.slug}` : "/dashboard";

  return (
    <header className="flex h-12 shrink-0 items-center border-b">
      <div className="flex items-center gap-2 px-6">
        <SidebarTrigger className="-ml-1 md:hidden" />
        <Separator
          orientation="vertical"
          className="mr-2 data-[orientation=vertical]:h-4 md:hidden"
        />
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem className="hidden md:block">
              <BreadcrumbLink render={<Link href={parentHref} />}>{parentLabel}</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="hidden md:block" />
            <BreadcrumbItem>
              <BreadcrumbPage>{title}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </div>
    </header>
  );
}
