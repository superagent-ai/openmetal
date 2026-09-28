export type ModalResourceUsage = {
  cpuCoreNanosecs: bigint;
  memGibNanosecs: bigint;
  gpuNanosecs: bigint;
  gpuType?: string;
};

// Large reservations over a day exceed Number.MAX_SAFE_INTEGER nanoseconds, so
// counters are kept as bigint. A double loses at most a few nanoseconds there.
function usageCounter(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value >= 0n ? value : undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? BigInt(Math.round(value)) : undefined;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return undefined;
}

export function parseResourceUsage(value: unknown): ModalResourceUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const cpuCoreNanosecs = usageCounter(record.cpuCoreNanosecs);
  const memGibNanosecs = usageCounter(record.memGibNanosecs);
  const gpuNanosecs = usageCounter(record.gpuNanosecs);
  if (cpuCoreNanosecs === undefined || memGibNanosecs === undefined || gpuNanosecs === undefined) {
    return undefined;
  }
  const gpuType = typeof record.gpuType === "string" ? record.gpuType : undefined;
  return { cpuCoreNanosecs, memGibNanosecs, gpuNanosecs, ...(gpuType ? { gpuType } : {}) };
}

export function usageFromMetadata(
  metadata: Record<string, unknown> | undefined,
): ModalResourceUsage | undefined {
  const modal = metadata?.modal;
  if (!modal || typeof modal !== "object" || !("finalResourceUsage" in modal)) return undefined;
  return parseResourceUsage(modal.finalResourceUsage);
}
