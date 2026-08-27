import { CircuitBoardIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/lib/utils";

export function OpenMetalLogo({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2 font-medium", className)}>
      <HugeiconsIcon icon={CircuitBoardIcon} strokeWidth={2} className="size-6" />
      <span>OpenMetal</span>
    </span>
  );
}
