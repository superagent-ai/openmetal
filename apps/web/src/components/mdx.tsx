import defaultMdxComponents from "fumadocs-ui/mdx";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import {
  ApiIcon,
  BookOpen01Icon,
  Key02Icon,
  Rocket02Icon,
  Route02Icon,
  SlidersHorizontalIcon,
  TerminalIcon,
  Wallet02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AnthropicMark,
  CodexMark,
  CopilotMark,
  CursorMark,
  PiAgentMark,
} from "@/components/agent-marks";
import type { MDXComponents } from "mdx/types";

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Tab,
    Tabs,
    AgentQuickstartIcon: () => <HugeiconsIcon icon={Rocket02Icon} strokeWidth={2} />,
    GuidesIcon: () => <HugeiconsIcon icon={BookOpen01Icon} strokeWidth={2} />,
    ApiReferenceIcon: () => <HugeiconsIcon icon={ApiIcon} strokeWidth={2} />,
    UnifiedApiIcon: () => <HugeiconsIcon icon={ApiIcon} strokeWidth={2} />,
    RuntimeIcon: () => <HugeiconsIcon icon={TerminalIcon} strokeWidth={2} />,
    FallbackIcon: () => <HugeiconsIcon icon={Route02Icon} strokeWidth={2} />,
    ByokIcon: () => <HugeiconsIcon icon={Key02Icon} strokeWidth={2} />,
    BalanceIcon: () => <HugeiconsIcon icon={Wallet02Icon} strokeWidth={2} />,
    ControlIcon: () => <HugeiconsIcon icon={SlidersHorizontalIcon} strokeWidth={2} />,
    ClaudeCodeMark: AnthropicMark,
    CursorMark,
    CodexMark,
    CopilotMark,
    PiAgentMark,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;
