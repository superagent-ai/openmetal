import { expect, it, vi } from "vitest";
import { DaytonaSandboxProvider } from "../src/index.js";

function toolboxFetch(uploadBodies: FormData[]) {
  return vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url);
    if (path.endsWith("/sandbox/sandbox-1")) {
      return Response.json({
        id: "sandbox-1",
        organizationId: "org-1",
        toolboxProxyUrl: "https://proxy.daytona.test/toolbox",
      });
    }
    if (path.includes("/files/info")) {
      return Response.json({ name: "note.txt", size: 1, isDir: false });
    }
    if (path.includes("/files/upload")) {
      uploadBodies.push(init?.body as FormData);
      return new Response(null, { status: 201 });
    }
    throw new Error(`Unexpected URL: ${path}`);
  });
}

it("uploads exactly the requested bytes for a pooled-size payload", async () => {
  const uploadBodies: FormData[] = [];
  const fetchImpl = toolboxFetch(uploadBodies);

  // Prime the shared 8 KiB Buffer pool with an adjacent marker the way concurrent
  // worker allocations do, then decode the tenant payload into the same pool page.
  const neighbor = Buffer.alloc(96, 0x41);
  const payload = Buffer.from("tenant-payload-marker-0123456789");
  expect(payload.buffer.byteLength).toBeGreaterThan(payload.byteLength);

  const provider = new DaytonaSandboxProvider({ apiKey: "test", fetchImpl });
  const result = await provider.writeFile({
    providerResourceId: "sandbox-1",
    path: "/tmp/note.txt",
    data: payload,
    mode: "overwrite",
  });

  expect(result).toMatchObject({ path: "/tmp/note.txt", bytesWritten: payload.length });
  expect(uploadBodies).toHaveLength(1);
  const blob = uploadBodies[0].get("file") as Blob;
  expect(blob.size).toBe(payload.length);
  const uploaded = new Uint8Array(await blob.arrayBuffer());
  expect(uploaded).toEqual(new Uint8Array(payload));
  expect(Buffer.from(uploaded).toString("latin1")).not.toContain(neighbor.toString("latin1"));
});

it("uploads exactly the requested bytes for a string payload", async () => {
  const uploadBodies: FormData[] = [];
  const fetchImpl = toolboxFetch(uploadBodies);

  const provider = new DaytonaSandboxProvider({ apiKey: "test", fetchImpl });
  const text = "hello daytona";
  await provider.writeFile({
    providerResourceId: "sandbox-1",
    path: "/tmp/note.txt",
    data: text,
    mode: "overwrite",
  });

  expect(uploadBodies).toHaveLength(1);
  const blob = uploadBodies[0].get("file") as Blob;
  expect(blob.size).toBe(text.length);
  expect(new TextDecoder().decode(await blob.arrayBuffer())).toBe(text);
});
