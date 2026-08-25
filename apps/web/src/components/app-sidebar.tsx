"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { parsePublicEvent, projectTopic } from "@openmetal/events";
import {
  Add01Icon,
  Analytics01Icon,
  CreditCardIcon,
  Database01Icon,
  Delete02Icon,
  Home01Icon,
  Key01Icon,
  MoreHorizontalIcon,
  PencilEdit01Icon,
  Settings04Icon,
  Tick02Icon,
  UserMultiple02Icon,
  WebhookIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { selectOrganization } from "@/app/dashboard/actions";
import { DeleteProjectDialog } from "@/components/delete-project-dialog";
import { NavUser } from "@/components/nav-user";
import { RenameProjectDialog } from "@/components/rename-project-dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { createClient } from "@/lib/supabase/client";
import { createMetalClient } from "@/lib/metal";
import { cn } from "@/lib/utils";

type Organization = {
  id: string;
  name: string;
  slug: string;
};

type Project = {
  id: string;
  name: string;
  slug: string;
  organization_id: string;
};

const organizationAvatarStyles = [
  "bg-blue-500/15 text-blue-700 ring-blue-500/25 dark:text-blue-300",
  "bg-violet-500/15 text-violet-700 ring-violet-500/25 dark:text-violet-300",
  "bg-emerald-500/15 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300",
  "bg-amber-500/15 text-amber-700 ring-amber-500/25 dark:text-amber-300",
  "bg-rose-500/15 text-rose-700 ring-rose-500/25 dark:text-rose-300",
  "bg-cyan-500/15 text-cyan-700 ring-cyan-500/25 dark:text-cyan-300",
] as const;

const runningResourceStatuses = new Set([
  "requested",
  "provisioning",
  "ready",
  "pausing",
  "provision_unknown",
  "stopping",
  "cleanup_pending",
  "cleanup_failed",
]);

function organizationAvatarClass(organizationId: string): string {
  let hash = 0;
  for (const character of organizationId) {
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  }
  return organizationAvatarStyles[Math.abs(hash) % organizationAvatarStyles.length]!;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
}

export function AppSidebar({
  user,
  organizations,
  preferredOrganizationId,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  user: { name: string; email: string };
  organizations: Organization[];
  preferredOrganizationId?: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [isSwitching, startTransition] = useTransition();
  const supabase = useMemo(() => createClient({ isSingleton: false }), []);
  const metal = useMemo(
    () =>
      createMetalClient(async () => {
        const { data } = await supabase.auth.getSession();
        return data.session?.access_token;
      }),
    [supabase],
  );
  const [projectState, setProjectState] = useState<{
    organizationId: string;
    projects: Project[];
  }>({ organizationId: "", projects: [] });
  const [runningProjectIds, setRunningProjectIds] = useState<Set<string>>(new Set());
  const [renamingProject, setRenamingProject] = useState<Project>();
  const [deletingProject, setDeletingProject] = useState<Project>();
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [projectMutationError, setProjectMutationError] = useState<string>();
  const routeSlug = pathname.split("/")[2];
  const activeOrganization =
    organizations.find((organization) => organization.slug === routeSlug) ??
    organizations.find((organization) => organization.id === preferredOrganizationId) ??
    organizations[0];
  const currentSection = pathname.includes("/projects")
    ? "projects"
    : (
        ["api-keys", "billing", "members", "providers", "settings", "usage", "webhooks"] as const
      ).find((section) => pathname.endsWith(`/${section}`));
  const basePath = activeOrganization ? `/dashboard/${activeOrganization.slug}` : "/dashboard";
  const navItems = [
    { title: "Home", url: basePath, icon: Home01Icon },
    { title: "API keys", url: `${basePath}/api-keys`, icon: Key01Icon },
    { title: "BYOK", url: `${basePath}/providers`, icon: Database01Icon },
    { title: "Webhooks", url: `${basePath}/webhooks`, icon: WebhookIcon },
    { title: "Billing", url: `${basePath}/billing`, icon: CreditCardIcon },
    { title: "Usage", url: `${basePath}/usage`, icon: Analytics01Icon },
    { title: "Members", url: `${basePath}/members`, icon: UserMultiple02Icon },
    { title: "Settings", url: `${basePath}/settings`, icon: Settings04Icon },
  ];
  const projects = useMemo(
    () => (projectState.organizationId === activeOrganization?.id ? projectState.projects : []),
    [activeOrganization?.id, projectState],
  );
  const routeProjectSlug = pathname.split("/")[4];
  const projectsLoading = Boolean(
    activeOrganization && projectState.organizationId !== activeOrganization.id,
  );

  useEffect(() => {
    if (!activeOrganization) {
      return;
    }

    let cancelled = false;
    const organizationId = activeOrganization.id;
    void metal.projects
      .list(organizationId)
      .then((result) => {
        if (!cancelled) {
          setProjectState({ organizationId, projects: result.projects });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProjectState({ organizationId, projects: [] });
        }
      });

    const handleProjectCreated = (event: Event) => {
      const detail = (event as CustomEvent<{ organizationId: string; project: Project }>).detail;
      if (detail.organizationId !== organizationId) {
        return;
      }
      setProjectState((current) => ({
        organizationId,
        projects: current.projects.some((project) => project.id === detail.project.id)
          ? current.projects
          : [...current.projects, detail.project],
      }));
    };
    window.addEventListener("metal:project-created", handleProjectCreated);

    return () => {
      cancelled = true;
      window.removeEventListener("metal:project-created", handleProjectCreated);
    };
  }, [activeOrganization, metal]);

  useEffect(() => {
    if (!activeOrganization || projects.length === 0) {
      return;
    }

    let cancelled = false;

    function updateProjectStatus(projectId: string, isRunning: boolean) {
      setRunningProjectIds((current) => {
        const next = new Set(current);
        if (isRunning) {
          next.add(projectId);
        } else {
          next.delete(projectId);
        }
        return next;
      });
    }

    async function refreshRunningProject(project: Project) {
      const { sandboxes } = await metal.sandboxes.list(project.id);
      if (!cancelled) {
        updateProjectStatus(
          project.id,
          sandboxes.some((sandbox) => runningResourceStatuses.has(sandbox.state)),
        );
      }
    }

    async function refreshRunningProjects() {
      const results = await Promise.all(
        projects.map(async (project) => {
          const { sandboxes } = await metal.sandboxes.list(project.id);
          return sandboxes.some((sandbox) => runningResourceStatuses.has(sandbox.state))
            ? project.id
            : undefined;
        }),
      );
      if (!cancelled) {
        setRunningProjectIds(new Set(results.filter((id): id is string => Boolean(id))));
      }
    }

    const channels = projects.map((project) => {
      const channel = supabase.channel(projectTopic(project.id), {
        config: { private: true },
      });
      channel.on("broadcast", { event: "*" }, (message) => {
        try {
          const event = parsePublicEvent(message.payload);
          if (event.project_id === project.id && event.type.startsWith("sandbox.") && !cancelled) {
            void refreshRunningProject(project).catch(() => undefined);
          }
        } catch {
          // Ignore unrelated or malformed broadcasts.
        }
      });
      return channel;
    });

    void refreshRunningProjects().catch(() => undefined);
    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (data.session?.access_token) {
        await supabase.realtime.setAuth(data.session.access_token);
      }
      if (!cancelled) {
        for (const [index, channel] of channels.entries()) {
          const project = projects[index];
          channel.subscribe((status) => {
            if (!cancelled && status === "SUBSCRIBED" && project) {
              void refreshRunningProject(project).catch(() => undefined);
            }
          });
        }
      }
    })();
    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.access_token) {
        void supabase.realtime.setAuth(session.access_token);
      }
    });

    return () => {
      cancelled = true;
      authListener.subscription.unsubscribe();
      for (const channel of channels) {
        void supabase.removeChannel(channel);
      }
    };
  }, [activeOrganization, metal, projects, supabase]);

  async function createUntitledProject() {
    if (!activeOrganization || isCreatingProject) {
      return;
    }

    setProjectMutationError(undefined);
    setIsCreatingProject(true);
    try {
      const project = await metal.projects.create(
        activeOrganization.id,
        {
          name: "Untitled",
          slug: `untitled-${crypto.randomUUID().slice(0, 8)}`,
        },
        { idempotencyKey: crypto.randomUUID() },
      );
      setProjectState((current) => ({
        organizationId: activeOrganization.id,
        projects: current.projects.some((item) => item.id === project.id)
          ? current.projects
          : [...current.projects, project],
      }));
      window.dispatchEvent(
        new CustomEvent("metal:project-created", {
          detail: { organizationId: activeOrganization.id, project },
        }),
      );
      router.push(`${basePath}/projects/${project.slug}`);
    } catch (error) {
      setProjectMutationError(
        error instanceof Error ? error.message : "Could not create the project",
      );
    } finally {
      setIsCreatingProject(false);
    }
  }

  async function renameProject(name: string) {
    if (!activeOrganization || !renamingProject) {
      return;
    }
    const slug = slugify(name);
    if (!slug) {
      throw new Error("Use at least one letter or number in the project name");
    }

    const project = await metal.projects.update(renamingProject.id, { name, slug });
    setProjectState((current) => ({
      organizationId: activeOrganization.id,
      projects: current.projects.map((item) => (item.id === project.id ? project : item)),
    }));
    window.dispatchEvent(
      new CustomEvent("metal:project-renamed", {
        detail: { organizationId: activeOrganization.id, project },
      }),
    );
    if (pathname.endsWith(`/projects/${renamingProject.slug}`)) {
      router.replace(`${basePath}/projects/${project.slug}`);
    }
  }

  async function deleteProject() {
    if (!activeOrganization || !deletingProject) {
      return;
    }

    await metal.projects.delete(deletingProject.id);
    setProjectState((current) => ({
      organizationId: activeOrganization.id,
      projects: current.projects.filter((project) => project.id !== deletingProject.id),
    }));
    window.dispatchEvent(
      new CustomEvent("metal:project-deleted", {
        detail: {
          organizationId: activeOrganization.id,
          projectId: deletingProject.id,
        },
      }),
    );
    if (routeProjectSlug === deletingProject.slug) {
      router.push(`${basePath}/projects`);
    }
  }

  return (
    <>
      <Sidebar collapsible="offcanvas" {...props}>
        <SidebarHeader className="h-12 justify-center border-b px-2 py-0">
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger className="flex h-9 w-full min-w-0 items-center gap-2 overflow-hidden rounded-md px-2 text-left text-sm outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring data-open:bg-sidebar-accent">
                  <Avatar className="size-7 rounded-md after:rounded-md">
                    <AvatarFallback
                      className={cn(
                        "rounded-md font-medium ring-1",
                        activeOrganization
                          ? organizationAvatarClass(activeOrganization.id)
                          : "bg-muted text-muted-foreground ring-border",
                      )}
                    >
                      {activeOrganization ? (
                        activeOrganization.name.slice(0, 1).toUpperCase()
                      ) : (
                        <HugeiconsIcon icon={Add01Icon} strokeWidth={2} className="size-3.5" />
                      )}
                    </AvatarFallback>
                  </Avatar>
                  <span className="flex-1 truncate text-sm font-medium">
                    {activeOrganization?.name ?? "New organization"}
                  </span>
                  <HugeiconsIcon
                    icon={MoreHorizontalIcon}
                    strokeWidth={2}
                    className="ml-auto size-4 text-muted-foreground"
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  side="bottom"
                  sideOffset={8}
                  className="min-w-60"
                >
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Organizations</DropdownMenuLabel>
                    {organizations.map((organization) => (
                      <DropdownMenuItem
                        key={organization.id}
                        disabled={isSwitching}
                        onClick={() => {
                          startTransition(() => {
                            void selectOrganization(organization.id, currentSection);
                          });
                        }}
                      >
                        <Avatar className="size-7 rounded-md after:rounded-md">
                          <AvatarFallback
                            className={cn(
                              "rounded-md font-medium ring-1",
                              organizationAvatarClass(organization.id),
                            )}
                          >
                            {organization.name.slice(0, 1).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <span className="flex-1 truncate">{organization.name}</span>
                        {organization.id === activeOrganization?.id ? (
                          <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="size-4" />
                        ) : null}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => router.push("/dashboard/new")}>
                    <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                    <div className="grid">
                      <span>New organization</span>
                      <span className="text-xs text-muted-foreground">
                        Create another organization
                      </span>
                    </div>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {navItems.map((item) => (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      className="h-9"
                      isActive={pathname === item.url}
                      render={activeOrganization ? <Link href={item.url} /> : undefined}
                      tooltip={item.title}
                      disabled={!activeOrganization}
                    >
                      <HugeiconsIcon icon={item.icon} strokeWidth={2} />
                      <span>{item.title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel>Projects</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {projectsLoading ? (
                  <>
                    <SidebarMenuItem>
                      <div className="flex h-9 items-center gap-2 px-2">
                        <Skeleton className="size-4 rounded-md" />
                        <Skeleton className="h-4 w-24" />
                      </div>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <div className="flex h-9 items-center gap-2 px-2">
                        <Skeleton className="size-4 rounded-md" />
                        <Skeleton className="h-4 w-16" />
                      </div>
                    </SidebarMenuItem>
                  </>
                ) : null}
                {!projectsLoading && projects.length === 0 ? (
                  <SidebarMenuItem>
                    <p className="px-2 py-1 text-xs text-muted-foreground">
                      {activeOrganization ? "No projects yet" : "Create an organization first"}
                    </p>
                  </SidebarMenuItem>
                ) : null}
                {projects.map((project) => (
                  <SidebarMenuItem key={project.id}>
                    <SidebarMenuButton
                      className="h-9"
                      isActive={routeProjectSlug === project.slug}
                      render={<Link href={`${basePath}/projects/${project.slug}`} />}
                      tooltip={project.name}
                    >
                      <span className="flex size-4 shrink-0 items-center justify-center">
                        <span
                          className={cn(
                            "size-2 rounded-full",
                            runningProjectIds.has(project.id)
                              ? "bg-emerald-500"
                              : "bg-muted-foreground/40",
                          )}
                          aria-label={
                            runningProjectIds.has(project.id)
                              ? "Has running resources"
                              : "No running resources"
                          }
                        />
                      </span>
                      <span>{project.name}</span>
                    </SidebarMenuButton>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <SidebarMenuAction
                            type="button"
                            showOnHover
                            aria-label={`Open ${project.name} menu`}
                            title={`Open ${project.name} menu`}
                          />
                        }
                      >
                        <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent side="right" align="start" sideOffset={4}>
                        <DropdownMenuItem onClick={() => setRenamingProject(project)}>
                          <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
                          Rename
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => setDeletingProject(project)}
                        >
                          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </SidebarMenuItem>
                ))}
                <SidebarMenuItem>
                  <SidebarMenuButton
                    className="h-9 text-muted-foreground"
                    type="button"
                    disabled={!activeOrganization || isCreatingProject}
                    tooltip="New project"
                    onClick={() => void createUntitledProject()}
                  >
                    <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                    <span>{isCreatingProject ? "Creating project" : "New project"}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                {projectMutationError ? (
                  <SidebarMenuItem>
                    <p className="px-2 py-1 text-xs text-destructive">{projectMutationError}</p>
                  </SidebarMenuItem>
                ) : null}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="gap-3 p-3 group-data-[collapsible=icon]:p-2">
          <NavUser
            user={user}
            settingsHref={activeOrganization ? `${basePath}/settings` : "/dashboard/settings"}
          />
        </SidebarFooter>
        <form id="logout-form" action="/auth/logout" method="post" className="hidden" />
      </Sidebar>
      {renamingProject ? (
        <RenameProjectDialog
          key={renamingProject.id}
          project={renamingProject}
          onOpenChange={(open) => {
            if (!open) {
              setRenamingProject(undefined);
            }
          }}
          onRename={renameProject}
        />
      ) : null}
      {deletingProject ? (
        <DeleteProjectDialog
          key={deletingProject.id}
          project={deletingProject}
          onOpenChange={(open) => {
            if (!open) {
              setDeletingProject(undefined);
            }
          }}
          onDelete={deleteProject}
        />
      ) : null}
    </>
  );
}
