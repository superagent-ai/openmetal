"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight01Icon, SidebarLeftIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNotebookLayout } from "fumadocs-ui/layouts/notebook";
import { Button } from "@/components/ui/button";
import { OpenMetalLogo } from "@/components/openmetal-logo";
import { createClient } from "@/lib/supabase/client";

export function DocsNavbar() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const { slots } = useNotebookLayout();
  const SearchFull = slots.searchTrigger ? slots.searchTrigger.full : null;
  const SearchSmall = slots.searchTrigger ? slots.searchTrigger.sm : null;
  const ThemeSwitch = slots.themeSwitch;
  const SidebarTrigger = slots.sidebar?.trigger;

  useEffect(() => {
    const supabase = createClient({ isSingleton: true });

    void supabase.auth.getClaims().then(({ data }) => {
      setIsAuthenticated(Boolean(data?.claims));
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setIsAuthenticated(Boolean(session));
    });

    return () => subscription.unsubscribe();
  }, []);

  return (
    <header className="sticky top-0 z-20 grid h-12 grid-cols-3 items-center border-b bg-background/80 px-4 backdrop-blur-sm [grid-area:header] layout:[--fd-header-height:--spacing(12)] md:px-6">
      <Link href="/" aria-label="OpenMetal documentation" className="justify-self-start">
        <OpenMetalLogo />
      </Link>

      <div className="hidden justify-self-center lg:block">
        {SearchFull ? <SearchFull hideIfDisabled className="w-80 rounded-xl" /> : null}
      </div>

      <div className="flex items-center gap-2 justify-self-end">
        {SearchSmall ? <SearchSmall hideIfDisabled className="p-2 lg:hidden" /> : null}
        {ThemeSwitch ? <ThemeSwitch /> : null}
        <Button
          nativeButton={false}
          render={<Link href={isAuthenticated ? "/dashboard" : "/login"} />}
        >
          {isAuthenticated ? "My account" : "Login"}
          <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} data-icon="inline-end" />
        </Button>
        {SidebarTrigger ? (
          <SidebarTrigger aria-label="Open documentation navigation" className="p-2 md:hidden">
            <HugeiconsIcon icon={SidebarLeftIcon} strokeWidth={2} />
          </SidebarTrigger>
        ) : null}
      </div>
    </header>
  );
}
