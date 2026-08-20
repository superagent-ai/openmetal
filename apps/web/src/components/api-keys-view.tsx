"use client";

import { useMemo, useState, type FormEvent } from "react";
import {
  Add01Icon,
  Copy01Icon,
  Delete02Icon,
  Key01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  name: string;
  slug: string;
  organization_id: string;
};

type ApiKey = {
  id: string;
  project_id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  deleted_at: string | null;
};

type Expiration = "1h" | "1d" | "7d" | "30d" | "90d" | "180d" | "1y" | null;

const expirationOptions: Array<{ value: Expiration; label: string }> = [
  { value: null, label: "No expiration" },
  { value: "1h", label: "1 hour" },
  { value: "1d", label: "1 day" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "180d", label: "180 days" },
  { value: "1y", label: "1 year" },
];

const dateFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatDate(value: string | null): string {
  return value ? dateFormatter.format(new Date(value)) : "Never";
}

function keyStatus(apiKey: ApiKey): "Active" | "Expired" | "Revoked" {
  if (apiKey.revoked_at) {
    return "Revoked";
  }
  if (apiKey.expires_at && new Date(apiKey.expires_at) <= new Date()) {
    return "Expired";
  }
  return "Active";
}

export function ApiKeysView({
  organizationName,
  projects,
  initialApiKeys,
}: {
  organizationName: string;
  projects: Project[];
  initialApiKeys: ApiKey[];
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
  const [apiKeys, setApiKeys] = useState(initialApiKeys);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [expiration, setExpiration] = useState<Expiration>(null);
  const [generatedKey, setGeneratedKey] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string>();
  const [isCreating, setIsCreating] = useState(false);
  const [revokingKey, setRevokingKey] = useState<ApiKey>();
  const [revokeError, setRevokeError] = useState<string>();
  const [isRevoking, setIsRevoking] = useState(false);
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );

  function resetCreateDialog() {
    setName("");
    setProjectId(projects[0]?.id ?? "");
    setExpiration(null);
    setGeneratedKey(undefined);
    setCopied(false);
    setError(undefined);
  }

  function openCreateDialog() {
    setIsCreateOpen(true);
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName || !projectId) {
      setError("Choose a project and enter a key name");
      return;
    }

    setError(undefined);
    setIsCreating(true);
    try {
      const result = await metal.apiKeys.create(projectId, {
        name: trimmedName,
        expires_in: expiration,
      });
      setApiKeys((current) => [result.api_key, ...current]);
      setGeneratedKey(result.key);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the API key");
    } finally {
      setIsCreating(false);
    }
  }

  async function handleCopy() {
    if (!generatedKey) {
      return;
    }
    await navigator.clipboard.writeText(generatedKey);
    setCopied(true);
  }

  async function handleRevoke() {
    if (!revokingKey) {
      return;
    }
    setRevokeError(undefined);
    setIsRevoking(true);
    try {
      if (revokingKey.revoked_at) {
        await metal.apiKeys.delete(revokingKey.project_id, revokingKey.id);
        setApiKeys((current) => current.filter((item) => item.id !== revokingKey.id));
        setRevokingKey(undefined);
        return;
      }
      const revoked = await metal.apiKeys.revoke(revokingKey.project_id, revokingKey.id);
      setApiKeys((current) => current.map((item) => (item.id === revoked.id ? revoked : item)));
      setRevokingKey(undefined);
    } catch (caught) {
      setRevokeError(caught instanceof Error ? caught.message : "Could not update the API key");
    } finally {
      setIsRevoking(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-balance">API keys</h1>
          <p className="mt-1 text-sm text-muted-foreground text-pretty">
            Create project scoped keys for accessing Metal from your applications.
          </p>
        </div>
        <Button type="button" onClick={openCreateDialog} disabled={projects.length === 0}>
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
          New API key
        </Button>
      </div>

      <div className="overflow-hidden rounded-xl border">
        <Table>
          <TableHeader className="bg-muted">
            <TableRow>
              <TableHead className="pl-4">Name</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>Project</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Expiration</TableHead>
              <TableHead className="w-20 pr-4 text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {apiKeys.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} className="h-56 whitespace-normal text-center">
                  <div className="mx-auto flex max-w-sm flex-col items-center gap-3">
                    <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <HugeiconsIcon icon={Key01Icon} strokeWidth={2} className="size-5" />
                    </div>
                    <div>
                      <p className="font-medium">No API keys yet</p>
                      <p className="mt-1 text-sm text-muted-foreground text-pretty">
                        Create a key to connect a project in {organizationName} to Metal.
                      </p>
                    </div>
                    {projects.length > 0 ? (
                      <Button type="button" variant="outline" onClick={openCreateDialog}>
                        Create API key
                      </Button>
                    ) : (
                      <p className="text-sm text-muted-foreground">Create a project first.</p>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              apiKeys.map((apiKey) => {
                const status = keyStatus(apiKey);
                return (
                  <TableRow key={apiKey.id}>
                    <TableCell className="pl-4 font-medium">{apiKey.name}</TableCell>
                    <TableCell>
                      <code className="rounded-md bg-muted px-2 py-1 text-xs">
                        {apiKey.prefix}••••••••
                      </code>
                    </TableCell>
                    <TableCell>{projectNames.get(apiKey.project_id) ?? "Unknown"}</TableCell>
                    <TableCell>
                      <Badge variant={status === "Active" ? "secondary" : "outline"}>
                        {status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(apiKey.last_used_at)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(apiKey.expires_at)}
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`${status === "Revoked" ? "Delete" : "Revoke"} ${apiKey.name}`}
                        title={`${status === "Revoked" ? "Delete" : "Revoke"} ${apiKey.name}`}
                        onClick={() => setRevokingKey(apiKey)}
                      >
                        <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
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
          {generatedKey ? (
            <>
              <DialogHeader>
                <DialogTitle>API key created</DialogTitle>
                <DialogDescription>
                  Copy this key now. For security, Metal will not show it again.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-2">
                <Label htmlFor="generated-api-key">Secret key</Label>
                <div className="flex gap-2">
                  <Input
                    id="generated-api-key"
                    value={generatedKey}
                    readOnly
                    className="font-mono"
                  />
                  <Button type="button" variant="outline" onClick={() => void handleCopy()}>
                    <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} strokeWidth={2} />
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
              </div>
              <DialogFooter>
                <DialogClose render={<Button type="button" />}>Done</DialogClose>
              </DialogFooter>
            </>
          ) : (
            <form onSubmit={handleCreate} className="grid gap-4">
              <DialogHeader>
                <DialogTitle>Create API key</DialogTitle>
                <DialogDescription>
                  Keys are scoped to one project. Choose an expiration that matches the workload.
                </DialogDescription>
              </DialogHeader>
              {error ? (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
              <div className="grid gap-2">
                <Label htmlFor="api-key-name">Name</Label>
                <Input
                  id="api-key-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder='e.g. "Chatbot key"'
                  maxLength={120}
                  autoFocus
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="api-key-project">Project</Label>
                <Select value={projectId} onValueChange={(value) => setProjectId(value ?? "")}>
                  <SelectTrigger id="api-key-project" className="w-full">
                    <SelectValue placeholder="Select a project">
                      {projectNames.get(projectId) ?? "Select a project"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="api-key-expiration">Expiration</Label>
                <Select
                  value={expiration ?? "never"}
                  onValueChange={(value) =>
                    setExpiration(value === "never" ? null : (value as Expiration))
                  }
                >
                  <SelectTrigger id="api-key-expiration" className="w-full">
                    <SelectValue>
                      {expirationOptions.find((option) => option.value === expiration)?.label ??
                        "No expiration"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    {expirationOptions.map((option) => (
                      <SelectItem key={option.value ?? "never"} value={option.value ?? "never"}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <DialogFooter>
                <DialogClose render={<Button type="button" variant="outline" />}>
                  Cancel
                </DialogClose>
                <Button type="submit" disabled={isCreating}>
                  {isCreating ? "Creating" : "Create API key"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {revokingKey ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setRevokingKey(undefined);
              setRevokeError(undefined);
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogMedia>
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
              </AlertDialogMedia>
              <AlertDialogTitle>
                {revokingKey.revoked_at ? "Delete" : "Revoke"} {revokingKey.name}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                {revokingKey.revoked_at
                  ? "The key will be removed from this table. Its audit metadata will be retained."
                  : "Applications using this key will immediately lose access. This cannot be undone."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {revokeError ? (
              <Alert variant="destructive">
                <AlertDescription>{revokeError}</AlertDescription>
              </Alert>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isRevoking}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={isRevoking}
                onClick={() => void handleRevoke()}
              >
                {isRevoking
                  ? revokingKey.revoked_at
                    ? "Deleting"
                    : "Revoking"
                  : revokingKey.revoked_at
                    ? "Delete key"
                    : "Revoke key"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}
