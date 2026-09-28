export const resourceDateFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export function formatDuration(startedAt: string | null, endedAt: string | null, now: number) {
  if (!startedAt || now === 0) {
    return "Not active";
  }
  const durationMs = Math.max(
    0,
    (endedAt ? new Date(endedAt).getTime() : now) - new Date(startedAt).getTime(),
  );
  const totalMinutes = Math.floor(durationMs / 60_000);
  if (totalMinutes < 1) {
    return "Less than a minute";
  }
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

export function formatMicrousd(value: string | null) {
  if (value === null) {
    return "Pending";
  }
  const amount = BigInt(value);
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `$${whole.toLocaleString("en-US")}.${fraction || "00"}`;
}
