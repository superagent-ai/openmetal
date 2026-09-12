"use client";

import { useRouter } from "next/navigation";
import {
  BookOpen02Icon,
  ComputerIcon,
  Logout01Icon,
  Moon02Icon,
  MoreHorizontalIcon,
  PaintBoardIcon,
  Sun03Icon,
  UserAccountIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTheme } from "next-themes";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";
import { resolveInitials } from "@/lib/user-profile";

export function NavUser({
  user,
}: {
  user: {
    name: string;
    email: string;
  };
}) {
  const { isMobile } = useSidebar();
  const { setTheme, theme } = useTheme();
  const router = useRouter();
  const initials = resolveInitials(user.name);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger className="flex h-10 w-full items-center gap-2 overflow-hidden rounded-lg bg-card px-2 text-left text-sm shadow-sm ring-1 ring-sidebar-border outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground">
            <Avatar className="size-7 rounded-md after:rounded-md">
              <AvatarFallback className="rounded-md">{initials}</AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
              <span className="truncate font-medium">{user.name}</span>
            </div>
            <HugeiconsIcon
              icon={MoreHorizontalIcon}
              strokeWidth={2}
              className="ml-auto size-4 text-muted-foreground group-data-[collapsible=icon]:hidden"
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-64 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="p-0 font-normal">
                <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                  <Avatar className="size-8 rounded-md after:rounded-md">
                    <AvatarFallback className="rounded-md">{initials}</AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{user.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{user.email}</span>
                  </div>
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => router.push("/dashboard/profile")}>
                <HugeiconsIcon icon={UserAccountIcon} strokeWidth={2} />
                Profile
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => router.push("/api-reference")}>
                <HugeiconsIcon icon={BookOpen02Icon} strokeWidth={2} />
                API Reference
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <div className="flex items-center gap-2 px-1.5 py-1">
              <HugeiconsIcon icon={PaintBoardIcon} strokeWidth={2} className="size-4" />
              <span className="flex-1 text-sm">Theme</span>
              <div className="flex items-center rounded-lg bg-muted p-0.5">
                {[
                  { value: "light", label: "Light", icon: Sun03Icon },
                  { value: "dark", label: "Dark", icon: Moon02Icon },
                  { value: "system", label: "System", icon: ComputerIcon },
                ].map((option) => (
                  <Button
                    key={option.value}
                    type="button"
                    variant={theme === option.value ? "secondary" : "ghost"}
                    size="icon-xs"
                    aria-label={`Use ${option.label.toLowerCase()} theme`}
                    aria-pressed={theme === option.value}
                    title={option.label}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setTheme(option.value);
                    }}
                  >
                    <HugeiconsIcon icon={option.icon} strokeWidth={2} />
                  </Button>
                ))}
              </div>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                const form = document.getElementById("logout-form");
                if (form instanceof HTMLFormElement) {
                  form.requestSubmit();
                }
              }}
            >
              <HugeiconsIcon icon={Logout01Icon} strokeWidth={2} />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
