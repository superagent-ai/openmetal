import "server-only";

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { siteName } from "./site";

export const ogImageSize = {
  width: 1200,
  height: 630,
};

export const ogImageContentType = "image/png";

const assetsDir = join(process.cwd(), "assets");
const backgroundSrc = `data:image/jpeg;base64,${await readFile(join(assetsDir, "og-background.jpg"), "base64")}`;
const geistRegular = await readFile(join(assetsDir, "geist-sans-latin-400.woff"));
const geistSemiBold = await readFile(join(assetsDir, "geist-sans-latin-600.woff"));

function clampText(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function OpenMetalMark() {
  return (
    <svg width="56" height="56" viewBox="0 0 1024 1024">
      <defs>
        <mask id="og-gateway-cut">
          <rect width="1024" height="1024" fill="#ffffff" />
          <rect x="574" y="448" width="450" height="144" fill="#000000" />
        </mask>
      </defs>
      <circle cx="512" cy="512" r="420" fill="#ffffff" mask="url(#og-gateway-cut)" />
    </svg>
  );
}

export async function createOgImage({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  const displayTitle = clampText(title, 80);
  const displayDescription = clampText(description, 160);
  const titleSize = displayTitle.length > 42 ? 60 : 76;

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
        backgroundColor: "#000000",
        color: "#ffffff",
        fontFamily: "Geist Sans",
      }}
    >
      {/* ImageResponse only supports <img>, not next/image. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={backgroundSrc}
        alt=""
        width={ogImageSize.width}
        height={ogImageSize.height}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          objectPosition: "right center",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          backgroundColor: "rgba(0, 0, 0, 0.55)",
        }}
      />
      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          width: "100%",
          height: "100%",
          padding: "72px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <OpenMetalMark />
          <div
            style={{
              display: "flex",
              marginLeft: 16,
              fontSize: 32,
              fontWeight: 600,
              letterSpacing: "-0.04em",
            }}
          >
            {siteName}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            maxWidth: 1000,
            marginBottom: 40,
          }}
        >
          <div
            style={{
              display: "flex",
              fontSize: titleSize,
              fontWeight: 600,
              lineHeight: 1.1,
              letterSpacing: "-0.04em",
              textWrap: "balance",
            }}
          >
            {displayTitle}
          </div>
          <div
            style={{
              display: "flex",
              marginTop: 24,
              fontSize: 38,
              fontWeight: 400,
              lineHeight: 1.35,
              color: "#F2F2F2",
              textWrap: "pretty",
            }}
          >
            {displayDescription}
          </div>
        </div>
      </div>
    </div>,
    {
      ...ogImageSize,
      fonts: [
        {
          name: "Geist Sans",
          data: geistRegular,
          style: "normal",
          weight: 400,
        },
        {
          name: "Geist Sans",
          data: geistSemiBold,
          style: "normal",
          weight: 600,
        },
      ],
    },
  );
}
