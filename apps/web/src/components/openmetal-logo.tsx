import { useId } from "react";
import { cn } from "@/lib/utils";

export function OpenMetalMark({ className }: { className?: string }) {
  const maskId = `gateway-cut-${useId().replace(/:/g, "")}`;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 1024 1024"
      className={cn("size-6", className)}
      aria-hidden="true"
    >
      <defs>
        <mask id={maskId}>
          <rect width="1024" height="1024" fill="#fff" />
          <rect x="574" y="448" width="450" height="144" fill="#000" />
        </mask>
      </defs>
      <circle cx="512" cy="512" r="420" className="fill-current" mask={`url(#${maskId})`} />
    </svg>
  );
}

export function OpenMetalLogo({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2 font-medium", className)}>
      <OpenMetalMark />
      <span>OpenMetal</span>
    </span>
  );
}
