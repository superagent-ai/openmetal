"use client";

import Image from "next/image";
import { useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import { Database01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  configureProviderCredential,
  removeProviderCredential,
} from "@/app/dashboard/[organizationSlug]/providers/actions";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

type ProviderName =
  | "blaxel"
  | "cloudflare"
  | "codesandbox"
  | "daytona"
  | "e2b"
  | "modal"
  | "northflank"
  | "runloop"
  | "vercel";

type ConfiguredProviderCredential = {
  id: string;
  organization_id: string;
  provider: ProviderName;
  created_at: string;
  updated_at: string;
};

type ProviderField = {
  name: string;
  label: string;
  placeholder: string;
  type?: "password" | "text" | "url";
  required?: boolean;
};

type ProviderDefinition = {
  name: ProviderName;
  label: string;
  logo: string;
  logoClassName?: string;
  fields: ProviderField[];
};

const providers: ProviderDefinition[] = [
  {
    name: "blaxel",
    label: "Blaxel",
    logo: "/providers/blaxel.png",
    fields: [
      {
        name: "api_key",
        label: "API key",
        placeholder: "Enter your API key",
        type: "password",
        required: true,
      },
      { name: "workspace", label: "Workspace", placeholder: "Your workspace name", required: true },
      { name: "account_id", label: "Account ID", placeholder: "Optional account ID" },
    ],
  },
  {
    name: "cloudflare",
    label: "Cloudflare",
    logo: "/providers/cloudflare.ico",
    fields: [
      {
        name: "api_url",
        label: "Sandbox API URL",
        placeholder: "https://sandbox.example.com",
        type: "url",
        required: true,
      },
      {
        name: "api_key",
        label: "API key",
        placeholder: "Enter your API key",
        type: "password",
        required: true,
      },
      { name: "account_id", label: "Account ID", placeholder: "Optional account ID" },
      {
        name: "analytics_token",
        label: "Analytics token",
        placeholder: "Optional analytics token",
        type: "password",
      },
    ],
  },
  {
    name: "codesandbox",
    label: "CodeSandbox",
    logo: "/providers/codesandbox.svg",
    logoClassName: "dark:invert",
    fields: [
      {
        name: "api_key",
        label: "API key",
        placeholder: "Enter your API key",
        type: "password",
        required: true,
      },
      { name: "workspace_id", label: "Workspace ID", placeholder: "Optional workspace ID" },
    ],
  },
  {
    name: "daytona",
    label: "Daytona",
    logo: "/providers/daytona.svg",
    fields: [
      {
        name: "api_key",
        label: "API key",
        placeholder: "Enter your API key",
        type: "password",
        required: true,
      },
      {
        name: "organization_id",
        label: "Organization ID",
        placeholder: "Optional organization ID",
      },
      { name: "target", label: "Target", placeholder: "Optional Daytona target" },
    ],
  },
  {
    name: "e2b",
    label: "E2B",
    logo: "/providers/e2b.png",
    logoClassName: "dark:invert",
    fields: [
      {
        name: "api_key",
        label: "API key",
        placeholder: "Enter your API key",
        type: "password",
        required: true,
      },
    ],
  },
  {
    name: "modal",
    label: "Modal",
    logo: "/providers/modal.svg",
    fields: [
      {
        name: "token_id",
        label: "Token ID",
        placeholder: "Enter your token ID",
        type: "password",
        required: true,
      },
      {
        name: "token_secret",
        label: "Token secret",
        placeholder: "Enter your token secret",
        type: "password",
        required: true,
      },
      { name: "environment", label: "Environment", placeholder: "Optional Modal environment" },
    ],
  },
  {
    name: "northflank",
    label: "Northflank",
    logo: "/providers/northflank.svg",
    fields: [
      {
        name: "api_token",
        label: "API token",
        placeholder: "Enter your API token",
        type: "password",
        required: true,
      },
      {
        name: "project_id",
        label: "Project ID",
        placeholder: "Your Northflank project ID",
        required: true,
      },
      { name: "team_id", label: "Team ID", placeholder: "Optional team ID" },
    ],
  },
  {
    name: "runloop",
    label: "Runloop",
    logo: "/providers/runloop.png",
    fields: [
      {
        name: "api_key",
        label: "API key",
        placeholder: "Enter your API key",
        type: "password",
        required: true,
      },
    ],
  },
  {
    name: "vercel",
    label: "Vercel",
    logo: "/providers/vercel.ico",
    logoClassName: "dark:invert",
    fields: [
      {
        name: "token",
        label: "Access token",
        placeholder: "Enter your access token",
        type: "password",
        required: true,
      },
      {
        name: "project_id",
        label: "Project ID",
        placeholder: "Your Vercel project ID",
        required: true,
      },
      { name: "team_id", label: "Team ID", placeholder: "Optional team ID" },
    ],
  },
];

export function ProviderCredentialsView({
  organizationId,
  organizationName,
  initialCredentials,
}: {
  organizationId: string;
  organizationName: string;
  initialCredentials: ConfiguredProviderCredential[];
}) {
  const [credentials, setCredentials] = useState(initialCredentials);
  const [selectedProvider, setSelectedProvider] = useState<ProviderDefinition>();
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [isSaving, setIsSaving] = useState(false);
  const [removingProvider, setRemovingProvider] = useState<ProviderDefinition>();
  const [removeError, setRemoveError] = useState<string>();
  const [isRemoving, setIsRemoving] = useState(false);
  const [activeTab, setActiveTab] = useState<"sandboxes" | "gpus">("sandboxes");
  const configuredProviders = useMemo(
    () => new Set(credentials.map((credential) => credential.provider)),
    [credentials],
  );

  function openConfiguration(provider: ProviderDefinition) {
    setSelectedProvider(provider);
    setValues({});
    setError(undefined);
  }

  function closeConfiguration() {
    setSelectedProvider(undefined);
    setValues({});
    setError(undefined);
  }

  function activateTab(tab: "sandboxes" | "gpus") {
    setActiveTab(tab);
    requestAnimationFrame(() => document.getElementById(`provider-tab-${tab}`)?.focus());
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      activateTab(activeTab === "sandboxes" ? "gpus" : "sandboxes");
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProvider) {
      return;
    }
    const missingField = selectedProvider.fields.find(
      (field) => field.required && !values[field.name]?.trim(),
    );
    if (missingField) {
      setError(`Enter ${missingField.label.toLowerCase()}`);
      return;
    }

    const credential = Object.fromEntries(
      Object.entries({ provider: selectedProvider.name, ...values }).filter(
        ([, value]) => value.trim().length > 0,
      ),
    ) as Parameters<typeof configureProviderCredential>[1];

    setError(undefined);
    setIsSaving(true);
    try {
      const configured = await configureProviderCredential(organizationId, credential);
      setCredentials((current) => [
        configured,
        ...current.filter((item) => item.provider !== configured.provider),
      ]);
      closeConfiguration();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save provider credentials");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleRemove() {
    if (!removingProvider) {
      return;
    }
    setRemoveError(undefined);
    setIsRemoving(true);
    try {
      await removeProviderCredential(organizationId, removingProvider.name);
      setCredentials((current) =>
        current.filter((credential) => credential.provider !== removingProvider.name),
      );
      setRemovingProvider(undefined);
    } catch (caught) {
      setRemoveError(caught instanceof Error ? caught.message : "Could not remove credentials");
    } finally {
      setIsRemoving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-balance">Bring your own keys</h1>
        <p className="mt-1 text-sm text-muted-foreground text-pretty">
          Connect provider accounts for {organizationName}. Resources use your credentials and are
          billed by the selected provider.
        </p>
      </div>

      <div className="space-y-4">
        <div
          role="tablist"
          aria-label="Provider types"
          className="inline-flex h-9 w-fit items-center rounded-lg bg-muted p-1"
        >
          <button
            id="provider-tab-sandboxes"
            type="button"
            role="tab"
            aria-selected={activeTab === "sandboxes"}
            aria-controls="provider-panel-sandboxes"
            tabIndex={activeTab === "sandboxes" ? 0 : -1}
            onClick={() => setActiveTab("sandboxes")}
            onKeyDown={handleTabKeyDown}
            className={cn(
              "inline-flex h-7 items-center justify-center rounded-md px-3 text-sm font-medium whitespace-nowrap outline-none transition-all duration-700 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 active:translate-y-px",
              activeTab === "sandboxes"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground",
            )}
          >
            Sandboxes
          </button>
          <button
            id="provider-tab-gpus"
            type="button"
            role="tab"
            aria-selected={activeTab === "gpus"}
            aria-controls="provider-panel-gpus"
            tabIndex={activeTab === "gpus" ? 0 : -1}
            onClick={() => setActiveTab("gpus")}
            onKeyDown={handleTabKeyDown}
            className={cn(
              "inline-flex h-7 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium whitespace-nowrap outline-none transition-all duration-700 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 active:translate-y-px",
              activeTab === "gpus"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground",
            )}
          >
            GPUs
            <span className="rounded-md bg-muted-foreground/10 px-1.5 py-0.5 text-xs">
              Coming soon
            </span>
          </button>
        </div>
        <div
          id="provider-panel-sandboxes"
          role="tabpanel"
          aria-labelledby="provider-tab-sandboxes"
          hidden={activeTab !== "sandboxes"}
        >
          <div className="overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader className="bg-muted">
                <TableRow>
                  <TableHead className="pl-4">Provider</TableHead>
                  <TableHead className="w-32 pr-4 text-right">
                    <span className="sr-only">Action</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {providers.map((provider) => {
                  const configured = configuredProviders.has(provider.name);
                  return (
                    <TableRow key={provider.name}>
                      <TableCell className="pl-4">
                        <div className="flex items-center gap-3">
                          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                            <Image
                              src={provider.logo}
                              alt={`${provider.label} logo`}
                              width={20}
                              height={20}
                              unoptimized
                              className={`size-5 object-contain ${provider.logoClassName ?? ""}`}
                            />
                          </div>
                          <div>
                            <p className="font-medium">{provider.label}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="pr-4 text-right">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => openConfiguration(provider)}
                        >
                          {configured ? "Reconfigure" : "Configure"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
        <div
          id="provider-panel-gpus"
          role="tabpanel"
          aria-labelledby="provider-tab-gpus"
          hidden={activeTab !== "gpus"}
        >
          <div className="flex h-56 flex-col items-center justify-center gap-3 rounded-xl border text-center">
            <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <HugeiconsIcon icon={Database01Icon} strokeWidth={2} className="size-5" />
            </div>
            <div>
              <h2 className="font-medium text-balance">GPU providers are coming soon</h2>
              <p className="mt-1 max-w-md text-sm text-muted-foreground text-pretty">
                You will be able to connect your own GPU cloud accounts from this tab.
              </p>
            </div>
          </div>
        </div>
      </div>

      <Dialog
        open={Boolean(selectedProvider)}
        onOpenChange={(open) => {
          if (!open && !isSaving) {
            closeConfiguration();
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          {selectedProvider ? (
            <form onSubmit={handleSubmit} className="grid gap-4">
              <DialogHeader>
                <DialogTitle>Configure {selectedProvider.label}</DialogTitle>
                <DialogDescription>
                  Credentials are encrypted and never shown again. Reconfiguring also updates
                  lifecycle access for existing sandboxes using this account.
                </DialogDescription>
              </DialogHeader>
              {error ? (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
              {selectedProvider.fields.map((field, index) => (
                <div key={field.name} className="grid gap-2">
                  <Label htmlFor={`provider-${field.name}`}>{field.label}</Label>
                  <Input
                    id={`provider-${field.name}`}
                    name={field.name}
                    type={field.type ?? "text"}
                    value={values[field.name] ?? ""}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [field.name]: event.target.value }))
                    }
                    placeholder={field.placeholder}
                    autoComplete={field.type === "password" ? "new-password" : "off"}
                    autoFocus={index === 0}
                    required={field.required}
                    disabled={isSaving}
                  />
                </div>
              ))}
              <DialogFooter>
                {configuredProviders.has(selectedProvider.name) ? (
                  <Button
                    type="button"
                    variant="destructive"
                    className="sm:mr-auto"
                    disabled={isSaving}
                    onClick={() => {
                      setRemovingProvider(selectedProvider);
                      closeConfiguration();
                    }}
                  >
                    Remove credentials
                  </Button>
                ) : null}
                <DialogClose
                  render={<Button type="button" variant="outline" disabled={isSaving} />}
                >
                  Cancel
                </DialogClose>
                <Button type="submit" disabled={isSaving}>
                  {isSaving ? "Saving" : "Save credentials"}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>

      {removingProvider ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open && !isRemoving) {
              setRemovingProvider(undefined);
              setRemoveError(undefined);
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogMedia>
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
              </AlertDialogMedia>
              <AlertDialogTitle>Remove {removingProvider.label} credentials?</AlertDialogTitle>
              <AlertDialogDescription>
                New sandboxes will use Metal managed credentials. Existing BYOK sandboxes retain
                access for lifecycle operations.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {removeError ? (
              <Alert variant="destructive">
                <AlertDescription>{removeError}</AlertDescription>
              </Alert>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isRemoving}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={isRemoving}
                onClick={() => void handleRemove()}
              >
                {isRemoving ? "Removing" : "Remove credentials"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}
