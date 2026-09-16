"use client";

import Link from "next/link";
import type { ComponentProps } from "react";

export function DocsSidebarFooter({ children, ...props }: ComponentProps<"div">) {
  return (
    <div
      {...props}
      className="mt-auto flex flex-col gap-2 px-4 py-3 text-xs text-fd-muted-foreground"
    >
      <div className="flex items-center gap-2 empty:hidden">{children}</div>
      <nav aria-label="Legal" className="flex items-center gap-3">
        <Link
          className="hover:text-fd-foreground hover:underline hover:underline-offset-4"
          href="/terms"
        >
          Terms of Service
        </Link>
        <Link
          className="hover:text-fd-foreground hover:underline hover:underline-offset-4"
          href="/privacy"
        >
          Privacy Policy
        </Link>
      </nav>
      <p className="text-pretty">© 2026 Superagent Technologies, Inc.</p>
    </div>
  );
}
