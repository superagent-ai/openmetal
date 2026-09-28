"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { parsePublicEvent, projectTopic } from "@openmetal/events";
import type { GpuJob } from "@openmetal/sdk";
import { ArrowLeft01Icon, Cancel01Icon, Download04Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
  appendGpuJobLogEvents,
  createGpuJobLogState,
  gpuJobLogText,
  type GpuJobLogState,
} from "@/lib/gpu-job-logs";
import {
  gpuDisplayName,
  gpuJobGpuLabel,
  gpuJobReasonLabel,
  isGpuJobCancellable,
  TERMINAL_GPU_JOB_STATES,
} from "@/lib/gpu-jobs";
import { createMetalClient } from "@/lib/metal";
import { formatDuration, formatMicrousd, resourceDateFormatter } from "@/lib/resource-format";
import { applyResourceCostUpdate, providerLabel } from "@/lib/resource-table";
import { statusBadgeClass } from "@/lib/status-badge";
import { createClient } from "@/lib/supabase/client";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

const LOG_POLL_INTERVAL_MS = 2_000;

function shellQuote(argument: string) {
  return /^[\w@%+=:,./-]+$/.test(argument) ? argument : `'${argument.replaceAll("'", `'\\''`)}'`;
}

function formatTimestamp(value: string | null | undefined) {
  return value ? `${resourceDateFormatter.format(new Date(value))} UTC` : "—";
}

function formatMemory(memoryMb: number | null | undefined) {
  if (!memoryMb) return "default memory";
  return memoryMb % 1024 === 0 ? `${memoryMb / 1024} GiB memory` : `${memoryMb} MB memory`;
}

function formatBytes(bytes: number) {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timeout = window.setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timeout);
      resolve();
    });
  });
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <article className="rounded-xl border bg-card p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </article>
  );
}

function DetailList({ items }: { items: Array<{ label: string; value: React.ReactNode }> }) {
  return (
    <dl className="divide-y">
      {items.map((item) => (
        <div key={item.label} className="grid gap-1 px-4 py-2.5 sm:grid-cols-[10rem_1fr]">
          <dt className="text-sm text-muted-foreground">{item.label}</dt>
          <dd className="min-w-0 text-sm break-words">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border">
      <div className="flex min-h-11 items-center justify-between gap-2 border-b bg-muted px-4 py-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function KeyValueList({ values, empty }: { values: Record<string, string>; empty: string }) {
  const entries = Object.entries(values);
  if (entries.length === 0) {
    return <span className="text-muted-foreground">{empty}</span>;
  }
  return (
    <ul className="space-y-1 font-mono text-xs">
      {entries.map(([key, value]) => (
        <li key={key}>
          <span className="text-muted-foreground">{key}=</span>
          {value}
        </li>
      ))}
    </ul>
  );
}

export function GpuJobDetail({
  organizationSlug,
  projectId,
  projectSlug,
  gpuJob,
}: {
  organizationSlug: string;
  projectId: string;
  projectSlug: string;
  gpuJob: GpuJob;
}) {
  const now = useNow();
  const supabase = useMemo(() => createClient({ isSingleton: false }), []);
  const metal = useMemo(
    () =>
      createMetalClient(async () => {
        const { data } = await supabase.auth.getSession();
        return data.session?.access_token;
      }),
    [supabase],
  );
  const [job, setJob] = useState(gpuJob);
  const [logs, setLogs] = useState<GpuJobLogState>(createGpuJobLogState);
  const [logsLoaded, setLogsLoaded] = useState(false);
  const [logError, setLogError] = useState<string>();
  const [error, setError] = useState<string>();
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const logViewport = useRef<HTMLPreElement>(null);
  const followLogs = useRef(true);
  const jobId = gpuJob.id;
  const projectHref = `/dashboard/${organizationSlug}/projects/${projectSlug}`;

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      let state = createGpuJobLogState();
      let complete = false;
      while (!controller.signal.aborted) {
        try {
          const events = await metal.gpuJobs.logBatchForProject(projectId, jobId, {
            lastEventId: state.lastSequence,
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          state = appendGpuJobLogEvents(state, events);
          setLogs(state);
          setLogsLoaded(true);
          setLogError(undefined);
          if (events.length > 0) continue;
          if (complete) return;
          const latest = await metal.gpuJobs.getForProject(projectId, jobId);
          if (controller.signal.aborted) return;
          setJob(latest);
          if (latest.logs_complete) {
            complete = true;
            continue;
          }
        } catch (caught) {
          if (controller.signal.aborted) return;
          setLogError(caught instanceof Error ? caught.message : "Could not load logs");
        }
        await sleep(LOG_POLL_INTERVAL_MS, controller.signal);
      }
    })();
    return () => controller.abort();
  }, [jobId, metal, projectId]);

  useEffect(() => {
    let cancelled = false;
    const channel = supabase.channel(projectTopic(projectId), { config: { private: true } });
    channel.on("broadcast", { event: "*" }, (message) => {
      try {
        const event = parsePublicEvent(message.payload);
        if (
          cancelled ||
          event.project_id !== projectId ||
          !event.type.startsWith("gpu_job.") ||
          event.data.gpu_job_id !== jobId
        ) {
          return;
        }
        if (event.type === "gpu_job.cost_updated") {
          setJob((current) => applyResourceCostUpdate([current], event.data)[0] ?? current);
          return;
        }
        void metal.gpuJobs
          .getForProject(projectId, jobId)
          .then((latest) => {
            if (!cancelled) setJob(latest);
          })
          .catch(() => undefined);
      } catch {
        // Ignore unrelated or malformed broadcasts on this project channel.
      }
    });
    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (data.session?.access_token) {
        await supabase.realtime.setAuth(data.session.access_token);
      }
      if (!cancelled) channel.subscribe();
    })();
    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.access_token) {
        void supabase.realtime.setAuth(session.access_token);
      }
    });
    return () => {
      cancelled = true;
      authListener.subscription.unsubscribe();
      void supabase.removeChannel(channel);
    };
  }, [jobId, metal, projectId, supabase]);

  useLayoutEffect(() => {
    const viewport = logViewport.current;
    if (viewport && followLogs.current) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [logs]);

  async function cancelJob() {
    setError(undefined);
    setCancelling(true);
    try {
      const { gpu_job: updated } = await metal.gpuJobs.cancelForProject(projectId, jobId);
      setJob(updated);
      setConfirmingCancel(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not cancel the GPU job");
    } finally {
      setCancelling(false);
    }
  }

  function downloadLogs() {
    const url = URL.createObjectURL(
      new Blob([gpuJobLogText(logs)], { type: "text/plain;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${job.id}.log`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const terminal = TERMINAL_GPU_JOB_STATES.has(job.state);
  const reason = gpuJobReasonLabel(job.state_reason);
  const gpuName = job.resolved
    ? `${job.resolved.gpu_count} × ${gpuDisplayName(job.resolved.gpu_type)}`
    : gpuJobGpuLabel(job);
  const hasLogs = logs.segments.length > 0;
  const logStatus = logError
    ? "Log updates paused, retrying"
    : !logsLoaded
      ? "Loading"
      : job.logs_complete
        ? "Complete"
        : job.state === "running" || job.state === "cancelling"
          ? "Streaming"
          : job.state === "provisioning" && job.submitted_at
            ? "Waiting for a GPU"
            : terminal
              ? "Collecting final output"
              : "Waiting for the job to start";
  const volumes = job.requested.provider_options?.modal?.volumes ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <Link
            href={projectHref}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} className="size-4" />
            Resources
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">GPU job</h1>
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{job.id}</code>
            <Badge variant="secondary" className={cn("capitalize", statusBadgeClass(job.state))}>
              {job.state.replaceAll("_", " ")}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {gpuName} on {providerLabel(job.provider)} · created {formatTimestamp(job.created_at)}
          </p>
        </div>
        {isGpuJobCancellable(job.state) ? (
          <Button type="button" variant="destructive" onClick={() => setConfirmingCancel(true)}>
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
            Cancel job
          </Button>
        ) : null}
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {job.state === "failed" || job.state === "timed_out" ? (
        <Alert variant="destructive">
          <AlertTitle>{reason ?? "The job failed"}</AlertTitle>
          {job.failure?.message ? <AlertDescription>{job.failure.message}</AlertDescription> : null}
        </Alert>
      ) : job.state === "cancelled" && reason ? (
        <Alert>
          <AlertTitle>{reason}</AlertTitle>
        </Alert>
      ) : job.state === "requested" && reason ? (
        <Alert>
          <AlertTitle>{reason}</AlertTitle>
          <AlertDescription>
            The job starts automatically, or fails if it has not started within{" "}
            {Math.round(job.requested.lifecycle.max_start_seconds / 60)} minutes of creation.
          </AlertDescription>
        </Alert>
      ) : job.state === "provision_unknown" ? (
        <Alert>
          <AlertTitle>Waiting for the provider to confirm this job</AlertTitle>
          <AlertDescription>
            Metal is checking whether the job started. It is not billed twice and will resolve on
            its own.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Cost"
          value={formatMicrousd(job.cost_microusd)}
          hint={
            job.cost_updated_at
              ? `Updated ${formatTimestamp(job.cost_updated_at)}${
                  terminal ? ". The final amount can change for a few minutes." : ""
                }`
              : "Waiting for provider usage data"
          }
        />
        <Stat
          label="Runtime"
          value={
            job.started_at
              ? formatDuration(job.started_at, job.finished_at, now)
              : job.submitted_at && !terminal
                ? "Waiting for a GPU"
                : "Not started"
          }
          hint={`Limit ${Math.round(job.requested.lifecycle.max_runtime_seconds / 60)} min from container start`}
        />
        <Stat
          label="GPU"
          value={gpuName}
          hint={
            job.resolved
              ? `${job.resolved.vram_gb_per_gpu} GB VRAM per GPU · ${job.resolved.provider_gpu}`
              : "Resolved when the job starts"
          }
        />
        <Stat
          label="Exit code"
          value={job.exit_code === null ? "—" : String(job.exit_code)}
          hint={terminal ? undefined : "Available when the job finishes"}
        />
      </div>

      <Section
        title="Logs"
        action={
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">{logStatus}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!hasLogs}
              onClick={downloadLogs}
            >
              <HugeiconsIcon icon={Download04Icon} strokeWidth={2} />
              Download
            </Button>
          </div>
        }
      >
        {logs.truncatedAtBytes !== null || job.logs_truncated ? (
          <p className="border-b bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-300">
            Output stopped being stored after{" "}
            {logs.truncatedAtBytes !== null ? formatBytes(logs.truncatedAtBytes) : "the log limit"}.
            The job kept running; write large outputs to a volume instead.
          </p>
        ) : null}
        <pre
          ref={logViewport}
          aria-label="GPU job logs"
          onScroll={(event) => {
            const target = event.currentTarget;
            followLogs.current = target.scrollHeight - target.scrollTop - target.clientHeight < 24;
          }}
          className="max-h-[32rem] min-h-40 overflow-auto bg-zinc-950 p-4 font-mono text-xs leading-5 whitespace-pre-wrap break-words text-zinc-100"
        >
          {hasLogs ? (
            logs.segments.map((segment, index) => (
              <span
                key={index}
                className={segment.stream === "stderr" ? "text-red-300" : undefined}
              >
                {segment.text}
              </span>
            ))
          ) : (
            <span className="text-zinc-400">
              {logsLoaded && job.logs_complete ? "This job produced no output." : "No output yet."}
            </span>
          )}
        </pre>
        {logError ? (
          <p className="border-t px-4 py-2 text-xs text-destructive">{logError}</p>
        ) : null}
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Configuration">
          <DetailList
            items={[
              {
                label: "Image",
                value: <code className="font-mono text-xs">{job.requested.source.image}</code>,
              },
              {
                label: "Command",
                value: (
                  <code className="font-mono text-xs">
                    {job.requested.source.command.map(shellQuote).join(" ")}
                  </code>
                ),
              },
              {
                label: "Working directory",
                value: job.requested.source.working_dir ?? "Image default",
              },
              {
                label: "CPU and memory",
                value: [
                  (job.resolved?.vcpu ?? job.requested.resources?.vcpu)
                    ? `${job.resolved?.vcpu ?? job.requested.resources?.vcpu} vCPU`
                    : "Default vCPU",
                  formatMemory(job.resolved?.memory_mb ?? job.requested.resources?.memory_mb),
                ].join(" · "),
              },
              {
                label: "Regions",
                value: job.requested.placement?.regions?.length
                  ? job.requested.placement.regions.join(", ")
                  : "Any region",
              },
              {
                label: "Pricing",
                value: `Est. $${job.pricing.estimated_hourly_cost_usd} per hour${
                  job.pricing.price_multiplier === "1.00"
                    ? ""
                    : ` · ${job.pricing.price_multiplier}× region multiplier`
                }`,
              },
              {
                label: "Start deadline",
                value: `${Math.round(job.requested.lifecycle.max_start_seconds / 60)} min after creation`,
              },
              {
                label: "Max cost",
                value: job.requested.limits?.max_cost_usd
                  ? `$${job.requested.limits.max_cost_usd}`
                  : "No limit",
              },
              {
                label: "Billing",
                value:
                  job.billing_mode === "byok" ? "Your provider account (BYOK)" : "Metal credits",
              },
              {
                label: "Image registry",
                value: job.requested.source.registry_auth
                  ? `Private (${job.requested.source.registry_auth.kind.replaceAll("_", " ")})`
                  : "Public",
              },
              {
                label: "Bucket mounts",
                value:
                  (job.requested.mounts ?? []).length === 0 ? (
                    <span className="text-muted-foreground">None</span>
                  ) : (
                    <ul className="space-y-1 font-mono text-xs">
                      {job.requested.mounts!.map((mount) => (
                        <li key={mount.mount_path}>
                          {mount.provider}://{mount.bucket}/{mount.key_prefix ?? ""} →{" "}
                          {mount.mount_path}
                          {mount.read_only ? " (read-only)" : ""}
                        </li>
                      ))}
                    </ul>
                  ),
              },
              {
                label: "Volumes",
                value:
                  volumes.length === 0 ? (
                    <span className="text-muted-foreground">None</span>
                  ) : (
                    <ul className="space-y-1 font-mono text-xs">
                      {volumes.map((volume) => (
                        <li key={volume.mount_path}>
                          {volume.name} → {volume.mount_path}
                        </li>
                      ))}
                    </ul>
                  ),
              },
            ]}
          />
        </Section>
        <div className="space-y-4">
          <Section title="Environment">
            <DetailList
              items={[
                {
                  label: "Variables",
                  value: <KeyValueList values={job.requested.environment ?? {}} empty="None" />,
                },
                {
                  label: "Secrets",
                  value:
                    job.requested.secret_names.length === 0 ? (
                      <span className="text-muted-foreground">None</span>
                    ) : (
                      <span className="font-mono text-xs">
                        {job.requested.secret_names.join(", ")}
                        <span className="ml-2 font-sans text-muted-foreground">
                          {terminal ? "(deleted)" : "(values hidden)"}
                        </span>
                      </span>
                    ),
                },
                {
                  label: "Metadata",
                  value: <KeyValueList values={job.requested.metadata ?? {}} empty="None" />,
                },
              ]}
            />
          </Section>
          <Section title="Timeline">
            <DetailList
              items={[
                { label: "Created", value: formatTimestamp(job.created_at) },
                { label: "Submitted to provider", value: formatTimestamp(job.submitted_at) },
                { label: "Container started", value: formatTimestamp(job.started_at) },
                ...(job.cancel_requested_at
                  ? [{ label: "Cancel requested", value: formatTimestamp(job.cancel_requested_at) }]
                  : []),
                { label: "Finished", value: formatTimestamp(job.finished_at) },
              ]}
            />
          </Section>
        </div>
      </div>

      {confirmingCancel ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open && !cancelling) setConfirmingCancel(false);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogMedia>
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
              </AlertDialogMedia>
              <AlertDialogTitle>Cancel this GPU job?</AlertDialogTitle>
              <AlertDialogDescription>
                The job stops on {providerLabel(job.provider)}. GPU time used so far is still
                billed, and files already written to volumes are kept.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={cancelling}>Keep running</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={cancelling}
                onClick={() => void cancelJob()}
              >
                {cancelling ? "Cancelling" : "Cancel job"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}
