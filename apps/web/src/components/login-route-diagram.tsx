import type { ReactNode } from "react";
import { CircuitBoardIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

const AGENTS = [
  { x: 361, y: 27, label: "Claude Code", mark: <AnthropicMark /> },
  { x: 283, y: 72, label: "Cursor", mark: <CursorMark /> },
  { x: 205, y: 117, label: "Codex", mark: <CodexMark /> },
  { x: 127, y: 162, label: "Copilot", mark: <CopilotMark /> },
  { x: 49, y: 207, label: "Pi", mark: <PiAgentMark /> },
] as const;

const SANDBOXES = [
  { x: 586, y: 137, label: "E2B", src: "/providers/e2b.png" },
  { x: 513, y: 179, label: "Daytona", src: "/providers/daytona.svg" },
  { x: 440, y: 221, label: "Modal", src: "/providers/modal.svg" },
  { x: 368, y: 263, label: "CodeSandbox", src: "/providers/codesandbox.svg", invert: true },
  { x: 295, y: 305, label: "Runloop", src: "/providers/runloop.png" },
  { x: 222, y: 347, label: "Northflank", src: "/providers/northflank.svg" },
] as const;

function BrandMark({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true" className="fill-foreground">
      {children}
    </svg>
  );
}

function AnthropicMark() {
  return (
    <BrandMark>
      <path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" />
    </BrandMark>
  );
}

function CursorMark() {
  return (
    <BrandMark>
      <path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" />
    </BrandMark>
  );
}

function CodexMark() {
  return (
    <BrandMark>
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.048 6.048 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.26 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8754-1.0478l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.5804-4.0764a4.4362 4.4362 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.5 4.5 0 0 1-6.0603-1.5972zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9723V11.6a.7663.7663 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071.0057l-4.83-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071-.0056l4.83 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.773-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.83-2.7866a4.5 4.5 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.499 4.499 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.607 1.4998v2.9994l-2.597 1.4997-2.6069-1.4997Z" />
    </BrandMark>
  );
}

function CopilotMark() {
  return (
    <BrandMark>
      <path d="M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z" />
    </BrandMark>
  );
}

function PiAgentMark() {
  return (
    <svg
      viewBox="0 0 800 800"
      width="19"
      height="19"
      aria-hidden="true"
      className="fill-foreground"
    >
      <path
        fillRule="evenodd"
        d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
      />
      <path d="M517.36 400H634.72V634.72H517.36Z" />
    </svg>
  );
}

function MetalMark() {
  return (
    <>
      <g transform="translate(1.5 1.5)" opacity="0.9">
        <HugeiconsIcon
          icon={CircuitBoardIcon}
          strokeWidth={3.5}
          width={30}
          height={30}
          aria-hidden="true"
          className="text-background"
        />
      </g>
      <HugeiconsIcon
        icon={CircuitBoardIcon}
        strokeWidth={2}
        width={30}
        height={30}
        aria-hidden="true"
        className="text-foreground"
      />
    </>
  );
}

function IsoTile({
  x,
  y,
  label,
  invert,
  children,
}: {
  x: number;
  y: number;
  label: string;
  invert?: boolean;
  children: ReactNode;
}) {
  return (
    <g>
      <ellipse cx={x} cy={y + 24} rx="24" ry="12" fill="var(--route-shadow)" />
      <line x1={x} y1={y} x2={x} y2={y + 24} stroke="var(--route-stem)" strokeWidth="1.5" />
      <polygon
        points={`${x - 28} ${y} ${x} ${y + 16} ${x} ${y + 24} ${x - 28} ${y + 8}`}
        fill="var(--route-side-left)"
      />
      <polygon
        points={`${x + 28} ${y} ${x} ${y + 16} ${x} ${y + 24} ${x + 28} ${y + 8}`}
        fill="var(--route-side-right)"
      />
      <polygon
        points={`${x} ${y - 16.5} ${x + 28.578} ${y} ${x} ${y + 16.5} ${x - 28.578} ${y}`}
        fill="var(--route-platform)"
        stroke="var(--route-platform-stroke)"
        strokeWidth="1"
      />
      <g
        className={invert ? "login-route-invert" : undefined}
        transform={`translate(${x} ${y}) matrix(0.866, -0.5, 0.866, 0.5, 0, 0) translate(-9.5 -9.5)`}
      >
        {children}
      </g>
      <text
        x={x}
        y={y + 41}
        textAnchor="middle"
        fontSize="9.5"
        fill="var(--route-label)"
        className="font-sans"
      >
        {label}
      </text>
    </g>
  );
}

export function LoginRouteDiagram() {
  return (
    <svg
      viewBox="18 0 600 406"
      className="login-route-diagram h-full w-full"
      role="img"
      aria-label="Claude Code, Cursor, Codex, Copilot and Pi all route through Metal to reach E2B, Daytona, Modal, CodeSandbox, Runloop and Northflank"
    >
      <defs>
        <pattern
          id="loginRouteIsoGrid"
          width="34"
          height="20"
          patternUnits="userSpaceOnUse"
          patternTransform="translate(300 212)"
        >
          <path
            d="M0 10 L17 0 L34 10 L17 20 Z"
            fill="none"
            stroke="var(--route-grid)"
            strokeWidth="1"
          />
        </pattern>
        <radialGradient id="loginRouteHubGlow">
          <stop offset="0%" stopColor="var(--route-hub-glow)" stopOpacity="0.14" />
          <stop offset="100%" stopColor="var(--route-hub-glow)" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="loginRouteGridFade">
          <stop offset="0%" stopColor="#fff" stopOpacity="1" />
          <stop offset="42%" stopColor="#fff" stopOpacity="0.92" />
          <stop offset="64%" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="82%" stopColor="#fff" stopOpacity="0.2" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <filter id="loginRouteGridSoften" x="-25%" y="-25%" width="150%" height="150%">
          <feGaussianBlur stdDeviation="10" />
        </filter>
        <mask id="loginRouteGridMask">
          <ellipse
            cx="312"
            cy="206"
            rx="330"
            ry="228"
            fill="url(#loginRouteGridFade)"
            filter="url(#loginRouteGridSoften)"
          />
        </mask>
      </defs>

      <g mask="url(#loginRouteGridMask)">
        <rect x="18" y="0" width="600" height="406" fill="url(#loginRouteIsoGrid)" />
      </g>

      <path
        d="M361 27 L 414 58 L 250 153"
        fill="none"
        stroke="var(--route-line)"
        strokeWidth="1.5"
      />
      <path
        d="M283 72 L 336 103 L 250 153"
        fill="none"
        stroke="var(--route-line)"
        strokeWidth="1.5"
      />
      <path
        d="M205 117 L 258 148 L 250 153"
        fill="none"
        stroke="var(--route-line)"
        strokeWidth="1.5"
      />
      <path
        d="M127 162 L 180 193 L 250 153"
        fill="none"
        stroke="var(--route-line)"
        strokeWidth="1.5"
      />
      <path
        d="M49 207 L 103 238 L 250 153"
        fill="none"
        stroke="var(--route-line)"
        strokeWidth="1.5"
      />
      <path
        d="M350 211 L 532 106 L 586 137"
        fill="none"
        stroke="var(--route-line)"
        strokeWidth="1.5"
      />
      <path
        d="M350 211 L 459 148 L 513 179"
        fill="none"
        stroke="var(--route-line)"
        strokeWidth="1.5"
      />
      <path
        d="M350 211 L 387 190 L 440 221"
        fill="none"
        stroke="var(--route-line)"
        strokeWidth="1.5"
      />
      <path
        d="M350 211 L 314 232 L 368 263"
        fill="none"
        stroke="var(--route-line)"
        strokeWidth="1.5"
      />
      <path
        d="M350 211 L 241 274 L 295 305"
        fill="none"
        stroke="var(--route-line)"
        strokeWidth="1.5"
      />
      <path
        d="M350 211 L 168 316 L 222 347"
        fill="none"
        stroke="var(--route-line)"
        strokeWidth="1.5"
      />
      <path
        d="M414 58 L 103 238"
        fill="none"
        stroke="var(--route-line)"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M532 106 L 168 316"
        fill="none"
        stroke="var(--route-line)"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M250 153 L 300 182"
        fill="none"
        stroke="var(--route-trunk-line)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M300 182 L 350 211"
        fill="none"
        stroke="var(--route-trunk-line)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <circle cx="250" cy="153" r="3.5" fill="var(--route-trunk-line)" />
      <circle cx="350" cy="211" r="3.5" fill="var(--route-trunk-line)" />

      <path
        d="M361 27 L 414 58 L 250 153"
        fill="none"
        stroke="var(--route-signal)"
        strokeWidth="4"
        strokeLinecap="round"
        className="hero-route-flow"
        style={{ animationDelay: "0s" }}
      />
      <path
        d="M283 72 L 336 103 L 250 153"
        fill="none"
        stroke="var(--route-signal)"
        strokeWidth="4"
        strokeLinecap="round"
        className="hero-route-flow"
        style={{ animationDelay: "-0.8s" }}
      />
      <path
        d="M205 117 L 258 148 L 250 153"
        fill="none"
        stroke="var(--route-signal)"
        strokeWidth="4"
        strokeLinecap="round"
        className="hero-route-flow"
        style={{ animationDelay: "-1.6s" }}
      />
      <path
        d="M127 162 L 180 193 L 250 153"
        fill="none"
        stroke="var(--route-signal)"
        strokeWidth="4"
        strokeLinecap="round"
        className="hero-route-flow"
        style={{ animationDelay: "-2.4s" }}
      />
      <path
        d="M49 207 L 103 238 L 250 153"
        fill="none"
        stroke="var(--route-signal)"
        strokeWidth="4"
        strokeLinecap="round"
        className="hero-route-flow"
        style={{ animationDelay: "-3.2s" }}
      />
      <path
        d="M350 211 L 532 106 L 586 137"
        fill="none"
        stroke="var(--route-signal)"
        strokeWidth="4"
        strokeLinecap="round"
        className="hero-route-flow"
        style={{ animationDelay: "-0.4s" }}
      />
      <path
        d="M350 211 L 459 148 L 513 179"
        fill="none"
        stroke="var(--route-signal)"
        strokeWidth="4"
        strokeLinecap="round"
        className="hero-route-flow"
        style={{ animationDelay: "-1.2s" }}
      />
      <path
        d="M350 211 L 387 190 L 440 221"
        fill="none"
        stroke="var(--route-signal)"
        strokeWidth="4"
        strokeLinecap="round"
        className="hero-route-flow"
        style={{ animationDelay: "-2s" }}
      />
      <path
        d="M350 211 L 314 232 L 368 263"
        fill="none"
        stroke="var(--route-signal)"
        strokeWidth="4"
        strokeLinecap="round"
        className="hero-route-flow"
        style={{ animationDelay: "-2.8s" }}
      />
      <path
        d="M350 211 L 241 274 L 295 305"
        fill="none"
        stroke="var(--route-signal)"
        strokeWidth="4"
        strokeLinecap="round"
        className="hero-route-flow"
        style={{ animationDelay: "-3.6s" }}
      />
      <path
        d="M350 211 L 168 316 L 222 347"
        fill="none"
        stroke="var(--route-signal)"
        strokeWidth="4"
        strokeLinecap="round"
        className="hero-route-flow"
        style={{ animationDelay: "-4.4s" }}
      />
      <path
        d="M250 153 L 300 182 L 350 211"
        fill="none"
        stroke="var(--route-signal)"
        strokeWidth="5"
        strokeLinecap="round"
        className="hero-route-trunk"
        style={{ animationDelay: "0s" }}
      />
      <path
        d="M250 153 L 300 182 L 350 211"
        fill="none"
        stroke="var(--route-signal)"
        strokeWidth="5"
        strokeLinecap="round"
        className="hero-route-trunk"
        style={{ animationDelay: "-1.4s" }}
      />

      {AGENTS.map((agent) => (
        <IsoTile key={agent.label} x={agent.x} y={agent.y} label={agent.label}>
          {agent.mark}
        </IsoTile>
      ))}

      <ellipse
        cx="300"
        cy="208"
        rx="92"
        ry="52"
        fill="url(#loginRouteHubGlow)"
        className="hero-route-pulse"
      />
      <polygon
        points="300 169 348.496 197 300 225 251.504 197"
        fill="var(--route-platform)"
        stroke="var(--route-platform-stroke)"
        strokeWidth="1"
      />
      <polygon
        points="300 161 348.496 189 300 217 251.504 189"
        fill="var(--route-platform)"
        stroke="var(--route-platform-stroke)"
        strokeWidth="1"
      />
      <polygon
        points="300 154 348.496 182 300 210 251.504 182"
        fill="var(--route-platform)"
        stroke="var(--route-hub-stroke)"
        strokeWidth="1.5"
      />
      <g transform="translate(300 182) matrix(0.866, -0.5, 0.866, 0.5, 0, 0) translate(-15 -15)">
        <MetalMark />
      </g>

      {SANDBOXES.map((sandbox) => (
        <IsoTile
          key={sandbox.label}
          x={sandbox.x}
          y={sandbox.y}
          label={sandbox.label}
          invert={"invert" in sandbox ? sandbox.invert : false}
        >
          <image href={sandbox.src} width="19" height="19" preserveAspectRatio="xMidYMid meet" />
        </IsoTile>
      ))}
    </svg>
  );
}
