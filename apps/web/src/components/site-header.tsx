"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
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
import { createMetalClient } from "@/lib/metal";
import { createClient } from "@/lib/supabase/client";

type Organization = {
  id: string;
  name: string;
  slug: string;
};

type Project = {
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
  const supabase = useMemo(() => createClient(), []);
  const metal = useMemo(
    () =>
      createMetalClient(async () => {
        const { data } = await supabase.auth.getSession();
        return data.session?.access_token;
      }),
    [supabase],
  );
  const [projects, setProjects] = useState<Project[]>([]);
  const routeSlug = pathname.split("/")[2];
  const activeOrganization =
    organizations.find((organization) => organization.slug === routeSlug) ??
    organizations.find((organization) => organization.id === preferredOrganizationId) ??
    organizations[0];
  const pageTitles: Record<string, string> = {
    "api-keys": "API keys",
    billing: "Billing",
    members: "Members",
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
  const routeProjectSlug = pathname.split("/")[4];
  const isProjectDetail = Boolean(
    activeOrganization && pathname.includes("/projects/") && routeProjectSlug,
  );
  const projectName =
    projects.find((project) => project.slug === routeProjectSlug)?.name ??
    routeProjectSlug?.replaceAll("-", " ");

  useEffect(() => {
    if (!activeOrganization || !isProjectDetail) {
      return;
    }
    let cancelled = false;
    void metal.projects
      .list(activeOrganization.id)
      .then((result) => {
        if (!cancelled) {
          setProjects(result.projects);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeOrganization, isProjectDetail, metal]);

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
            {isProjectDetail ? (
              <>
                <BreadcrumbItem>
                  <BreadcrumbLink render={<Link href={`${parentHref}/projects`} />}>
                    {title}
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage className="capitalize">{projectName}</BreadcrumbPage>
                </BreadcrumbItem>
              </>
            ) : (
              <BreadcrumbItem>
                <BreadcrumbPage>{title}</BreadcrumbPage>
              </BreadcrumbItem>
            )}
          </BreadcrumbList>
        </Breadcrumb>
      </div>
    </header>
  );
}
