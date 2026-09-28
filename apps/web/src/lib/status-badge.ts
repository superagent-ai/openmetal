/** Badge colors shared by sandbox and GPU job states. */
export function statusBadgeClass(status: string) {
  if (status === "ready" || status === "running" || status === "succeeded") {
    return "bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300";
  }
  if (status === "requested" || status === "provisioning" || status === "routing") {
    return "bg-sky-500/15 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300";
  }
  if (
    status === "pausing" ||
    status === "stopping" ||
    status === "cleanup_pending" ||
    status === "cancelling"
  ) {
    return "bg-amber-500/15 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300";
  }
  if (status === "failed" || status === "cleanup_failed" || status === "timed_out") {
    return "bg-destructive/10 text-destructive dark:bg-destructive/20";
  }
  if (status === "provision_unknown") {
    return "bg-violet-500/15 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300";
  }
  return "bg-muted text-muted-foreground";
}
