"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Add01Icon,
  Delete02Icon,
  FolderCodeIcon,
  MoreHorizontalIcon,
  PencilEdit01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DeleteProjectDialog } from "@/components/delete-project-dialog";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RenameProjectDialog } from "@/components/rename-project-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createMetalClient } from "@/lib/metal";
import { createClient } from "@/lib/supabase/client";

type Project = {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  created_at: string;
  updated_at: string;
};

const dateFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatDate(value: string): string {
  return dateFormatter.format(new Date(value));
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
}

function uniqueSlug(name: string, projects: Project[]): string {
  const base = slugify(name);
  if (!base) {
    return "";
  }
  const taken = new Set(projects.map((project) => project.slug));
  if (!taken.has(base)) {
    return base;
  }
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${base.slice(0, 63 - tail.length)}${tail}`.replace(/^-+|-+$/g, "");
    if (candidate && !taken.has(candidate)) {
      return candidate;
    }
  }
  return "";
}

function sortProjects(projects: Project[]): Project[] {
  return [...projects].sort((left, right) =>
    left.name.localeCompare(right.name, "en", { sensitivity: "base" }),
  );
}

export function ProjectsView({
  organizationId,
  organizationName,
  organizationSlug,
  initialProjects,
}: {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  initialProjects: Project[];
}) {
  const supabase = useMemo(() => createClient(), []);
  const metal = useMemo(
    () =>
      createMetalClient(async () => {
        const { data } = await supabase.auth.getSession();
        return data.session?.access_token;
      }),
    [supabase],
  );
  const [projects, setProjects] = useState(initialProjects);
  const [query, setQuery] = useState("");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [createError, setCreateError] = useState<string>();
  const [isCreating, setIsCreating] = useState(false);
  const [renamingProject, setRenamingProject] = useState<Project>();
  const [deletingProject, setDeletingProject] = useState<Project>();
  const previewSlug = uniqueSlug(name, projects);

  const rows = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const filtered =
      normalized.length === 0
        ? projects
        : projects.filter(
            (project) =>
              project.name.toLowerCase().includes(normalized) ||
              project.slug.toLowerCase().includes(normalized),
          );
    return sortProjects(filtered);
  }, [projects, query]);

  useEffect(() => {
    const handleProjectCreated = (event: Event) => {
      const detail = (event as CustomEvent<{ organizationId: string; project: Project }>).detail;
      if (detail.organizationId !== organizationId) {
        return;
      }
      setProjects((current) =>
        current.some((project) => project.id === detail.project.id)
          ? current
          : [...current, detail.project],
      );
    };
    const handleProjectRenamed = (event: Event) => {
      const detail = (event as CustomEvent<{ organizationId: string; project: Project }>).detail;
      if (detail.organizationId !== organizationId) {
        return;
      }
      setProjects((current) =>
        current.map((project) => (project.id === detail.project.id ? detail.project : project)),
      );
    };
    const handleProjectDeleted = (event: Event) => {
      const detail = (event as CustomEvent<{ organizationId: string; projectId: string }>).detail;
      if (detail.organizationId !== organizationId) {
        return;
      }
      setProjects((current) => current.filter((project) => project.id !== detail.projectId));
    };

    window.addEventListener("metal:project-created", handleProjectCreated);
    window.addEventListener("metal:project-renamed", handleProjectRenamed);
    window.addEventListener("metal:project-deleted", handleProjectDeleted);
    return () => {
      window.removeEventListener("metal:project-created", handleProjectCreated);
      window.removeEventListener("metal:project-renamed", handleProjectRenamed);
      window.removeEventListener("metal:project-deleted", handleProjectDeleted);
    };
  }, [organizationId]);

  function resetCreateDialog() {
    setName("");
    setCreateError(undefined);
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    const slug = uniqueSlug(trimmedName, projects);
    if (!trimmedName || !slug) {
      setCreateError("Use at least one letter or number in the project name");
      return;
    }

    setCreateError(undefined);
    setIsCreating(true);
    try {
      const project = await metal.projects.create(
        organizationId,
        { name: trimmedName, slug },
        { idempotencyKey: crypto.randomUUID() },
      );
      setProjects((current) =>
        current.some((item) => item.id === project.id) ? current : [...current, project],
      );
      window.dispatchEvent(
        new CustomEvent("metal:project-created", {
          detail: { organizationId, project },
        }),
      );
      setIsCreateOpen(false);
      resetCreateDialog();
    } catch (caught) {
      setCreateError(caught instanceof Error ? caught.message : "Could not create the project");
    } finally {
      setIsCreating(false);
    }
  }

  async function renameProject(nextName: string) {
    if (!renamingProject) {
      return;
    }
    const slug = slugify(nextName);
    if (!slug) {
      throw new Error("Use at least one letter or number in the project name");
    }
    const project = await metal.projects.update(renamingProject.id, { name: nextName, slug });
    setProjects((current) => current.map((item) => (item.id === project.id ? project : item)));
    window.dispatchEvent(
      new CustomEvent("metal:project-renamed", {
        detail: { organizationId, project },
      }),
    );
  }

  async function deleteProject() {
    if (!deletingProject) {
      return;
    }
    await metal.projects.delete(deletingProject.id);
    setProjects((current) => current.filter((project) => project.id !== deletingProject.id));
    window.dispatchEvent(
      new CustomEvent("metal:project-deleted", {
        detail: { organizationId, projectId: deletingProject.id },
      }),
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-balance">Projects</h1>
          <p className="mt-1 text-sm text-muted-foreground text-pretty">
            Create and manage sandbox projects for {organizationName}.
          </p>
        </div>
        <Button type="button" onClick={() => setIsCreateOpen(true)}>
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
          New project
        </Button>
      </div>

      <div className="relative w-full sm:max-w-sm">
        <HugeiconsIcon
          icon={Search01Icon}
          strokeWidth={2}
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search projects…"
          aria-label="Search projects"
          className="pl-8"
        />
      </div>

      <div className="overflow-hidden rounded-xl border">
        <Table>
          <TableHeader className="bg-muted">
            <TableRow>
              <TableHead className="pl-4">Name</TableHead>
              <TableHead>Slug</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead className="w-16 pr-4 text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="h-56 whitespace-normal text-center">
                  <div className="mx-auto flex max-w-sm flex-col items-center gap-3">
                    <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <HugeiconsIcon icon={FolderCodeIcon} strokeWidth={2} className="size-5" />
                    </div>
                    <div>
                      <p className="font-medium">
                        {projects.length === 0 ? "No projects yet" : "No matching projects"}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground text-pretty">
                        {projects.length === 0
                          ? `Create a project to manage sandbox resources in ${organizationName}.`
                          : "Try a different search."}
                      </p>
                    </div>
                    {projects.length === 0 ? (
                      <Button type="button" variant="outline" onClick={() => setIsCreateOpen(true)}>
                        Create project
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              rows.map((project) => (
                <TableRow key={project.id}>
                  <TableCell className="pl-4">
                    <Link
                      href={`/dashboard/${organizationSlug}/projects/${project.slug}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {project.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <code className="rounded-md bg-muted px-2 py-1 text-xs">{project.slug}</code>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(project.created_at)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(project.updated_at)}
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Open actions for ${project.name}`}
                          />
                        }
                      >
                        <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
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
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog
        open={isCreateOpen}
        onOpenChange={(open) => {
          setIsCreateOpen(open);
          if (!open) {
            resetCreateDialog();
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <form onSubmit={handleCreate} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Create project</DialogTitle>
              <DialogDescription>
                Projects group sandboxes, API keys, and resources in {organizationName}.
              </DialogDescription>
            </DialogHeader>
            {createError ? (
              <Alert variant="destructive">
                <AlertDescription>{createError}</AlertDescription>
              </Alert>
            ) : null}
            <div className="grid gap-2">
              <Label htmlFor="project-name">Name</Label>
              <Input
                id="project-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder='e.g. "Production"'
                maxLength={120}
                autoFocus
                required
              />
              {previewSlug ? (
                <p className="text-xs text-muted-foreground">
                  Slug <span className="font-mono text-foreground">{previewSlug}</span>
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
              <Button type="submit" disabled={isCreating}>
                {isCreating ? "Creating" : "Create project"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

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
    </div>
  );
}
