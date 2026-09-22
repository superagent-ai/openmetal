import { describe, expect, it } from "vitest";
import {
  brandedTitle,
  dashboardPageMetadata,
  pageMetadata,
  resolvePageDescription,
  resolvePageTitle,
} from "./page-metadata";

describe("page metadata", () => {
  it("uses the branded home title on the root path", () => {
    expect(resolvePageTitle("Home", "/")).toBe("OpenMetal — The Compute Gateway for AI Agents");
    expect(resolvePageTitle("Create a sandbox", "/guides/create-sandbox")).toBe("Create a sandbox");
  });

  it("keeps authored descriptions and fills API pages that omit one", () => {
    expect(
      resolvePageDescription(
        "Create a sandbox",
        "Provision portable compute.",
        "/guides/create-sandbox",
      ),
    ).toBe("Provision portable compute.");
    expect(
      resolvePageDescription(
        "Create Sandbox",
        undefined,
        "/api-reference/endpoints/sandboxes/createSandbox",
      ),
    ).toBe("Create Sandbox in the OpenMetal REST API.");
    expect(resolvePageDescription("Routing", undefined, "/concepts/routing")).toBe(
      "Routing in the OpenMetal documentation.",
    );
  });

  it("sets canonical, Open Graph, and Twitter tags from the page copy", () => {
    const metadata = pageMetadata({
      title: "Create a sandbox",
      description: "Provision portable compute and wait until it is ready.",
      path: "/guides/create-sandbox",
      type: "article",
    });

    expect(metadata.title).toBe("Create a sandbox");
    expect(metadata.alternates).toMatchObject({ canonical: "/guides/create-sandbox" });
    expect(metadata.openGraph).toMatchObject({
      title: "Create a sandbox | OpenMetal",
      url: "/guides/create-sandbox",
      type: "article",
    });
    expect(metadata.openGraph?.images).toEqual([
      {
        url: "/api/og?title=Create+a+sandbox&description=Provision+portable+compute+and+wait+until+it+is+ready.",
        width: 1200,
        height: 630,
        alt: "Create a sandbox — OpenMetal",
      },
    ]);
    expect(metadata.twitter).toMatchObject({
      card: "summary_large_image",
      title: "Create a sandbox | OpenMetal",
    });
  });

  it("keeps private dashboard pages out of the index", () => {
    const metadata = dashboardPageMetadata({
      title: "Billing",
      description: "Credits, invoices, and payment methods.",
      path: "/dashboard/acme/billing",
    });

    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(brandedTitle("Billing")).toBe("Billing | OpenMetal");
  });

  it("lets file-based metadata own images for static route segments", () => {
    const metadata = pageMetadata({
      title: "Sign in",
      description: "Access OpenMetal.",
      path: "/login",
      image: false,
    });

    expect(metadata.openGraph?.images).toBeUndefined();
    expect(metadata.twitter?.images).toBeUndefined();
  });
});
