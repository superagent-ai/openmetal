"use client";

import { useMemo, useState, type FormEvent } from "react";
import {
  Add01Icon,
  Copy01Icon,
  Delete02Icon,
  Tick02Icon,
  WebhookIcon,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type EventTypeValue } from "@openmetal/events";
import { createMetalClient } from "@/lib/metal";
import { createClient } from "@/lib/supabase/client";

type WebhookEndpoint = {
  id: string;
  organization_id: string;
  name: string;
  url: string;
  event_types: string[];
  enabled: boolean;
  secret_prefix: string;
  rotated_at: string | null;
  last_delivery_at: string | null;
  last_delivery_status: string | null;
  created_at: string;
  updated_at: string;
  disabled_at: string | null;
};

type WebhookDelivery = {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  status: "pending" | "delivering" | "succeeded" | "retrying" | "failed";
  attempt_count: number;
  next_attempt_at: string | null;
  last_http_status: number | null;
  last_error: string | null;
  last_latency_ms: number | null;
  is_test: boolean;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
};

const dateFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatDate(value: string | null): string {
  return value ? dateFormatter.format(new Date(value)) : "Never";
}

function endpointStatus(endpoint: WebhookEndpoint): "Disabled" | "Failing" | "Active" {
  if (!endpoint.enabled || endpoint.disabled_at) {
    return "Disabled";
  }
  if (endpoint.last_delivery_status === "failed") {
    return "Failing";
  }
  return "Active";
}

function formatEvents(eventTypes: string[]): string {
  if (eventTypes.length === 0) {
    return "All events";
  }
  if (eventTypes.length <= 2) {
    return eventTypes.join(", ");
  }
  return `${eventTypes.slice(0, 2).join(", ")} +${eventTypes.length - 2} more`;
}

export function WebhooksView({
  organizationId,
  organizationName,
  initialEndpoints,
  eventCatalog,
}: {
  organizationId: string;
  organizationName: string;
  initialEndpoints: WebhookEndpoint[];
  eventCatalog: EventTypeValue[];
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
  const [endpoints, setEndpoints] = useState(initialEndpoints);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editing, setEditing] = useState<WebhookEndpoint>();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<EventTypeValue[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [revealedSecret, setRevealedSecret] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string>();
  const [isSaving, setIsSaving] = useState(false);
  const [rotating, setRotating] = useState<WebhookEndpoint>();
  const [rotateError, setRotateError] = useState<string>();
  const [isRotating, setIsRotating] = useState(false);
  const [removing, setRemoving] = useState<WebhookEndpoint>();
  const [removeError, setRemoveError] = useState<string>();
  const [isRemoving, setIsRemoving] = useState(false);
  const [historyEndpoint, setHistoryEndpoint] = useState<WebhookEndpoint>();
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [historyError, setHistoryError] = useState<string>();
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [testingId, setTestingId] = useState<string>();
  const [testResult, setTestResult] = useState<string>();
  const [redeliveringId, setRedeliveringId] = useState<string>();

  function resetDialog() {
    setEditing(undefined);
    setName("");
    setUrl("");
    setSelectedEvents([]);
    setEnabled(true);
    setRevealedSecret(undefined);
    setCopied(false);
    setError(undefined);
  }

  function openCreateDialog() {
    resetDialog();
    setIsDialogOpen(true);
  }

  function openEditDialog(endpoint: WebhookEndpoint) {
    resetDialog();
    setEditing(endpoint);
    setName(endpoint.name);
    setUrl(endpoint.url);
    setSelectedEvents(endpoint.event_types as EventTypeValue[]);
    setEnabled(endpoint.enabled);
    setIsDialogOpen(true);
  }

  function toggleEvent(type: EventTypeValue) {
    setSelectedEvents((current) =>
      current.includes(type) ? current.filter((item) => item !== type) : [...current, type],
    );
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();
    if (!trimmedName || !trimmedUrl) {
      setError("Enter a name and a destination URL");
      return;
    }
    setError(undefined);
    setIsSaving(true);
    try {
      if (editing) {
        const updated = await metal.webhooks.update(organizationId, editing.id, {
          name: trimmedName,
          url: trimmedUrl,
          event_types: selectedEvents,
          enabled,
        });
        setEndpoints((current) => current.map((item) => (item.id === updated.id ? updated : item)));
        setIsDialogOpen(false);
        resetDialog();
      } else {
        const created = await metal.webhooks.create(organizationId, {
          name: trimmedName,
          url: trimmedUrl,
          event_types: selectedEvents,
          enabled,
        });
        const { secret, ...endpoint } = created;
        setEndpoints((current) => [endpoint, ...current]);
        setRevealedSecret(secret);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the endpoint");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleCopy() {
    if (!revealedSecret) {
      return;
    }
    await navigator.clipboard.writeText(revealedSecret);
    setCopied(true);
  }

  async function handleRotate() {
    if (!rotating) {
      return;
    }
    setRotateError(undefined);
    setIsRotating(true);
    try {
      const rotated = await metal.webhooks.rotate(organizationId, rotating.id);
      const { secret, ...endpoint } = rotated;
      setEndpoints((current) => current.map((item) => (item.id === endpoint.id ? endpoint : item)));
      setRotating(undefined);
      resetDialog();
      setIsDialogOpen(true);
      setRevealedSecret(secret);
    } catch (caught) {
      setRotateError(caught instanceof Error ? caught.message : "Could not rotate the secret");
    } finally {
      setIsRotating(false);
    }
  }

  async function handleRemove() {
    if (!removing) {
      return;
    }
    setRemoveError(undefined);
    setIsRemoving(true);
    try {
      await metal.webhooks.delete(organizationId, removing.id);
      setEndpoints((current) => current.filter((item) => item.id !== removing.id));
      setRemoving(undefined);
    } catch (caught) {
      setRemoveError(caught instanceof Error ? caught.message : "Could not delete the endpoint");
    } finally {
      setIsRemoving(false);
    }
  }

  async function openHistory(endpoint: WebhookEndpoint) {
    setHistoryEndpoint(endpoint);
    setDeliveries([]);
    setHistoryError(undefined);
    setTestResult(undefined);
    setIsHistoryLoading(true);
    try {
      const result = await metal.webhooks.listDeliveries(organizationId, endpoint.id, {
        limit: 50,
      });
      setDeliveries(result.deliveries);
    } catch (caught) {
      setHistoryError(caught instanceof Error ? caught.message : "Could not load deliveries");
    } finally {
      setIsHistoryLoading(false);
    }
  }

  async function handleTest(endpoint: WebhookEndpoint) {
    setTestingId(endpoint.id);
    setTestResult(undefined);
    try {
      const delivery = await metal.webhooks.test(organizationId, endpoint.id);
      setTestResult(
        `Test delivery ${delivery.id} enqueued at ${formatDate(delivery.created_at)}. Watch its status in the delivery history.`,
      );
      if (historyEndpoint?.id === endpoint.id) {
        const result = await metal.webhooks.listDeliveries(organizationId, endpoint.id, {
          limit: 50,
        });
        setDeliveries(result.deliveries);
      }
    } catch (caught) {
      setTestResult(caught instanceof Error ? caught.message : "Could not send the test delivery");
    } finally {
      setTestingId(undefined);
    }
  }

  async function handleRedeliver(delivery: WebhookDelivery) {
    setRedeliveringId(delivery.id);
    try {
      const updated = await metal.webhooks.redeliver(
        organizationId,
        delivery.endpoint_id,
        delivery.id,
      );
      setDeliveries((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (caught) {
      setHistoryError(caught instanceof Error ? caught.message : "Could not redeliver");
    } finally {
      setRedeliveringId(undefined);
    }
  }

  const historyTitle = useMemo(
    () => (historyEndpoint ? `Deliveries for ${historyEndpoint.name}` : "Deliveries"),
    [historyEndpoint],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-balance">Webhooks</h1>
          <p className="mt-1 text-sm text-muted-foreground text-pretty">
            Deliver lifecycle events from {organizationName} to your systems with signed requests.
          </p>
        </div>
        <Button type="button" onClick={openCreateDialog}>
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
          New endpoint
        </Button>
      </div>

      <div className="overflow-hidden rounded-xl border">
        <Table>
          <TableHeader className="bg-muted">
            <TableRow>
              <TableHead className="pl-4">Name</TableHead>
              <TableHead>URL</TableHead>
              <TableHead>Events</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last delivery</TableHead>
              <TableHead className="w-44 pr-4 text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {endpoints.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="h-56 whitespace-normal text-center">
                  <div className="mx-auto flex max-w-sm flex-col items-center gap-3">
                    <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <HugeiconsIcon icon={WebhookIcon} strokeWidth={2} className="size-5" />
                    </div>
                    <div>
                      <p className="font-medium">No webhook endpoints yet</p>
                      <p className="mt-1 text-sm text-muted-foreground text-pretty">
                        Create an endpoint to deliver events from {organizationName} to your
                        systems.
                      </p>
                    </div>
                    <Button type="button" variant="outline" onClick={openCreateDialog}>
                      Create endpoint
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              endpoints.map((endpoint) => {
                const status = endpointStatus(endpoint);
                return (
                  <TableRow key={endpoint.id}>
                    <TableCell className="pl-4 font-medium">{endpoint.name}</TableCell>
                    <TableCell>
                      <code className="max-w-56 truncate rounded-md bg-muted px-2 py-1 text-xs">
                        {endpoint.url}
                      </code>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatEvents(endpoint.event_types)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={status === "Active" ? "secondary" : "outline"}>
                        {status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(endpoint.last_delivery_at)}
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => void openHistory(endpoint)}
                        >
                          History
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={testingId === endpoint.id}
                          onClick={() => void handleTest(endpoint)}
                        >
                          {testingId === endpoint.id ? "Testing" : "Test"}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => openEditDialog(endpoint)}
                        >
                          Edit
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Delete ${endpoint.name}`}
                          title={`Delete ${endpoint.name}`}
                          onClick={() => setRemoving(endpoint)}
                        >
                          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {testResult ? (
        <Alert>
          <AlertDescription>{testResult}</AlertDescription>
        </Alert>
      ) : null}

      <Dialog
        open={isDialogOpen}
        onOpenChange={(open) => {
          setIsDialogOpen(open);
          if (!open) {
            resetDialog();
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          {revealedSecret ? (
            <>
              <DialogHeader>
                <DialogTitle>Signing secret created</DialogTitle>
                <DialogDescription>
                  Copy this secret now. Metal stores only what is needed to sign deliveries and will
                  not show it again. Rotating invalidates the previous secret immediately.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-2">
                <Label htmlFor="generated-webhook-secret">Signing secret</Label>
                <div className="flex gap-2">
                  <Input
                    id="generated-webhook-secret"
                    value={revealedSecret}
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
            <form onSubmit={handleSave} className="grid gap-4">
              <DialogHeader>
                <DialogTitle>{editing ? "Edit endpoint" : "Create endpoint"}</DialogTitle>
                <DialogDescription>
                  Choose which events to deliver. Leave all events unchecked to receive every event.
                </DialogDescription>
              </DialogHeader>
              {error ? (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
              <div className="grid gap-2">
                <Label htmlFor="webhook-name">Name</Label>
                <Input
                  id="webhook-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder='e.g. "Deploy hook"'
                  maxLength={120}
                  autoFocus
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="webhook-url">Destination URL</Label>
                <Input
                  id="webhook-url"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://example.com/metal-events"
                  maxLength={2048}
                  inputMode="url"
                  required
                />
                <p className="text-xs text-muted-foreground">
                  Production endpoints must use public HTTPS URLs without embedded credentials.
                </p>
              </div>
              <div className="grid gap-2">
                <Label>Events</Label>
                <div className="grid max-h-48 gap-1 overflow-y-auto rounded-md border p-2">
                  {eventCatalog.map((type) => (
                    <label key={type} className="flex items-center gap-2 px-1 py-1 text-sm">
                      <input
                        type="checkbox"
                        className="size-4 accent-current"
                        checked={selectedEvents.includes(type)}
                        onChange={() => toggleEvent(type)}
                      />
                      <code className="text-xs">{type}</code>
                    </label>
                  ))}
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-current"
                  checked={enabled}
                  onChange={(event) => setEnabled(event.target.checked)}
                />
                Enabled
              </label>
              <DialogFooter>
                <DialogClose render={<Button type="button" variant="outline" />}>
                  Cancel
                </DialogClose>
                <Button type="submit" disabled={isSaving}>
                  {isSaving ? "Saving" : editing ? "Save changes" : "Create endpoint"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {rotating ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setRotating(undefined);
              setRotateError(undefined);
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogMedia>
                <HugeiconsIcon icon={WebhookIcon} strokeWidth={2} />
              </AlertDialogMedia>
              <AlertDialogTitle>Rotate secret for {rotating.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                A new signing secret is generated and the previous secret stops working immediately.
                Update your consumer before deliveries signed with the old secret expire.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {rotateError ? (
              <Alert variant="destructive">
                <AlertDescription>{rotateError}</AlertDescription>
              </Alert>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isRotating}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={isRotating}
                onClick={() => void handleRotate()}
              >
                {isRotating ? "Rotating" : "Rotate secret"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}

      {removing ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setRemoving(undefined);
              setRemoveError(undefined);
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogMedia>
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
              </AlertDialogMedia>
              <AlertDialogTitle>Delete {removing.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                Deliveries stop immediately and the signing secret is destroyed. Delivery history is
                retained for audit.
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
                {isRemoving ? "Deleting" : "Delete endpoint"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}

      <Dialog
        open={Boolean(historyEndpoint)}
        onOpenChange={(open) => {
          if (!open) {
            setHistoryEndpoint(undefined);
            setDeliveries([]);
            setHistoryError(undefined);
          }
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{historyTitle}</DialogTitle>
            <DialogDescription>
              Recent delivery attempts. Metal retries network failures, 408, 429, and 5xx responses,
              and deduplicates by event.
            </DialogDescription>
          </DialogHeader>
          {historyError ? (
            <Alert variant="destructive">
              <AlertDescription>{historyError}</AlertDescription>
            </Alert>
          ) : null}
          {isHistoryLoading ? (
            <p className="text-sm text-muted-foreground">Loading deliveries…</p>
          ) : deliveries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No deliveries yet.</p>
          ) : (
            <div className="max-h-96 overflow-y-auto rounded-md border">
              <Table>
                <TableHeader className="bg-muted">
                  <TableRow>
                    <TableHead className="pl-4">Event</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Attempts</TableHead>
                    <TableHead>HTTP</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead className="pr-4 text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deliveries.map((delivery) => (
                    <TableRow key={delivery.id}>
                      <TableCell className="pl-4">
                        <code className="text-xs">{delivery.event_type}</code>
                        {delivery.is_test ? (
                          <Badge variant="outline" className="ml-2">
                            test
                          </Badge>
                        ) : null}
                        {delivery.last_error ? (
                          <p className="mt-1 max-w-64 truncate text-xs text-muted-foreground">
                            {delivery.last_error}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Badge variant={delivery.status === "succeeded" ? "secondary" : "outline"}>
                          {delivery.status}
                        </Badge>
                      </TableCell>
                      <TableCell>{delivery.attempt_count}</TableCell>
                      <TableCell>{delivery.last_http_status ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDate(delivery.updated_at)}
                      </TableCell>
                      <TableCell className="pr-4 text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={
                            redeliveringId === delivery.id ||
                            delivery.status === "pending" ||
                            delivery.status === "delivering"
                          }
                          onClick={() => void handleRedeliver(delivery)}
                        >
                          {redeliveringId === delivery.id ? "Queuing" : "Redeliver"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <DialogFooter>
            {historyEndpoint ? (
              <Button type="button" variant="outline" onClick={() => setRotating(historyEndpoint)}>
                Rotate secret
              </Button>
            ) : null}
            <DialogClose render={<Button type="button" />}>Close</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
