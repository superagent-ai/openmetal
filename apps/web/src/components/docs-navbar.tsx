"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight01Icon, SidebarLeftIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNotebookLayout } from "fumadocs-ui/layouts/notebook";
import { Button } from "@/components/ui/button";
import { OpenMetalLogo } from "@/components/openmetal-logo";
import { createClient } from "@/lib/supabase/client";

const GITHUB_REPOSITORY_URL = "https://github.com/superagent-ai/openmetal";

function GitHubMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" data-icon="inline-start">
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.564 9.564 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  );
}

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
          variant="outline"
          render={<a href={GITHUB_REPOSITORY_URL} target="_blank" rel="noreferrer noopener" />}
        >
          <GitHubMark />
          GitHub
        </Button>
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
