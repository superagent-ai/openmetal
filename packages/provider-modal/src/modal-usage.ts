export type ModalResourceUsage = {
  cpuCoreNanosecs: number;
  memGibNanosecs: number;
  gpuNanosecs: number;
  gpuType?: string;
};

function validUsageValue(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseResourceUsage(value: unknown): ModalResourceUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (
    !("cpuCoreNanosecs" in value) ||
    !validUsageValue(value.cpuCoreNanosecs) ||
    !("memGibNanosecs" in value) ||
    !validUsageValue(value.memGibNanosecs) ||
    !("gpuNanosecs" in value) ||
    !validUsageValue(value.gpuNanosecs)
  ) {
    return undefined;
  }
  const gpuType =
    "gpuType" in value && typeof value.gpuType === "string" ? value.gpuType : undefined;
  return {
    cpuCoreNanosecs: value.cpuCoreNanosecs,
    memGibNanosecs: value.memGibNanosecs,
    gpuNanosecs: value.gpuNanosecs,
    ...(gpuType ? { gpuType } : {}),
  };
}

export function usageFromMetadata(
  metadata: Record<string, unknown> | undefined,
): ModalResourceUsage | undefined {
  const modal = metadata?.modal;
  if (!modal || typeof modal !== "object" || !("finalResourceUsage" in modal)) return undefined;
  return parseResourceUsage(modal.finalResourceUsage);
}
