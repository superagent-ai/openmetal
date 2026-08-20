import { describe, expect, it, vi } from "vitest";
import { MetalClient, type MetalError } from "../src/index.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("MetalClient unit", () => {
  it("maps a stable error envelope", async () => {
    const client = new MetalClient({
      baseUrl: "http://localhost:4000",
      accessToken: async () => "token-1",
      fetch: async () =>
        jsonResponse(401, {
          code: "unauthenticated",
          message: "missing token",
          request_id: "req_1",
        }),
    });
    await expect(client.organizations.list()).rejects.toMatchObject({
      code: "unauthenticated",
      requestId: "req_1",
      status: 401,
    } satisfies Partial<MetalError>);
  });

  it("rejects malformed JSON", async () => {
    const client = new MetalClient({
      baseUrl: "http://localhost:4000",
      accessToken: async () => "token-1",
      fetch: async () => new Response("not-json", { status: 200 }),
    });
    await expect(client.health()).rejects.toMatchObject({ code: "internal_error" });
  });

  it("times out when the fetch hangs", async () => {
    const client = new MetalClient({
      baseUrl: "http://localhost:4000",
      accessToken: async () => "token-1",
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    });
    await expect(client.health()).rejects.toMatchObject({ code: "timeout" });
  });

  it("refreshes the access token on each request", async () => {
    const tokens = ["first", "second"];
    const seen: string[] = [];
    const client = new MetalClient({
      baseUrl: "http://localhost:4000",
      accessToken: async () => tokens.shift(),
      fetch: async (_url, init) => {
        const header = new Headers(init?.headers).get("authorization");
        seen.push(header ?? "");
        return jsonResponse(200, { status: "ok" });
      },
    });
    await client.health();
    await client.health();
    expect(seen).toEqual(["Bearer first", "Bearer second"]);
  });

  it("retries idempotent GET requests on 503", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        jsonResponse(503, {
          code: "service_unavailable",
          message: "try later",
          request_id: "r1",
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { status: "ok" }));
    const client = new MetalClient({
      baseUrl: "http://localhost:4000",
      accessToken: async () => "t",
      retry: { attempts: 1, backoffMs: 1 },
      fetch: fetchMock,
    });
    await expect(client.health()).resolves.toEqual({ status: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry POST writes", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(
        jsonResponse(503, {
          code: "service_unavailable",
          message: "try later",
          request_id: "r1",
        }),
      );
    const client = new MetalClient({
      baseUrl: "http://localhost:4000",
      accessToken: async () => "t",
      retry: { attempts: 2, backoffMs: 1 },
      fetch: fetchMock,
    });
    await expect(client.organizations.create({ name: "A", slug: "a" })).rejects.toMatchObject({
      status: 503,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends an idempotency key on eligible writes", async () => {
    let captured: string | null = null;
    const client = new MetalClient({
      baseUrl: "http://localhost:4000",
      accessToken: async () => "t",
      fetch: async (_url, init) => {
        captured = new Headers(init?.headers).get("idempotency-key");
        return jsonResponse(201, {
          id: "11111111-1111-4111-8111-111111111111",
          name: "A",
          slug: "a",
          created_at: "2026-08-20T00:00:00.000Z",
          updated_at: "2026-08-20T00:00:00.000Z",
        });
      },
    });
    await client.organizations.create({ name: "A", slug: "a" }, { idempotencyKey: "k-1" });
    expect(captured).toBe("k-1");
  });

  it("updates a project with PATCH", async () => {
    let capturedMethod: string | undefined;
    let capturedBody: string | undefined;
    const client = new MetalClient({
      baseUrl: "http://localhost:4000",
      accessToken: async () => "t",
      fetch: async (_url, init) => {
        capturedMethod = init?.method;
        capturedBody = init?.body?.toString();
        return jsonResponse(200, {
          id: "11111111-1111-4111-8111-111111111111",
          organization_id: "22222222-2222-4222-8222-222222222222",
          name: "Renamed",
          slug: "renamed",
          created_at: "2026-08-20T00:00:00.000Z",
          updated_at: "2026-08-20T01:00:00.000Z",
        });
      },
    });

    await expect(
      client.projects.update("11111111-1111-4111-8111-111111111111", {
        name: "Renamed",
        slug: "renamed",
      }),
    ).resolves.toMatchObject({ name: "Renamed" });
    expect(capturedMethod).toBe("PATCH");
    expect(capturedBody).toBe(JSON.stringify({ name: "Renamed", slug: "renamed" }));
  });

  it("deletes a project with DELETE", async () => {
    let capturedMethod: string | undefined;
    const client = new MetalClient({
      baseUrl: "http://localhost:4000",
      accessToken: async () => "t",
      fetch: async (_url, init) => {
        capturedMethod = init?.method;
        return jsonResponse(200, {
          id: "11111111-1111-4111-8111-111111111111",
          deleted: true,
        });
      },
    });

    await expect(client.projects.delete("11111111-1111-4111-8111-111111111111")).resolves.toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      deleted: true,
    });
    expect(capturedMethod).toBe("DELETE");
  });
});
