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
          retryable: false,
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
          retryable: true,
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

  it("retrieves and validates finite operation event batches", async () => {
    let captured: { url: string; headers: Headers } | undefined;
    const first = {
      sequence: 5,
      operation_id: "op_abc123",
      type: "attempt_started",
      occurred_at: "2026-08-20T12:00:00.000Z",
      data: { provider: "e2b" },
    };
    const second = {
      sequence: 6,
      operation_id: "op_abc123",
      type: "state_changed",
      occurred_at: "2026-08-20T12:00:01.000Z",
      data: { state: "running" },
    };
    const client = new MetalClient({
      baseUrl: "http://localhost:4000",
      accessToken: async () => "t",
      fetch: async (url, init) => {
        captured = { url: String(url), headers: new Headers(init?.headers) };
        return new Response(
          `id: 5\nevent: attempt_started\ndata: ${JSON.stringify(first)}\n\n` +
            `id: 6\nevent: state_changed\ndata: ${JSON.stringify(second)}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    });

    await expect(client.operations.events("op_abc123", { lastEventId: 4 })).resolves.toEqual([
      first,
      second,
    ]);
    expect(captured?.url).toBe("http://localhost:4000/v1/operations/op_abc123/events");
    expect(captured?.headers.get("accept")).toBe("text/event-stream");
    expect(captured?.headers.get("last-event-id")).toBe("4");
  });

  it("rejects operation event batches whose SSE metadata disagrees with the data", async () => {
    const client = new MetalClient({
      baseUrl: "http://localhost:4000",
      accessToken: async () => "t",
      fetch: async () =>
        new Response(
          'id: 2\nevent: queued\ndata: {"sequence":1,"operation_id":"op_abc123","type":"queued","occurred_at":"2026-08-20T12:00:00.000Z","data":{}}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });

    await expect(client.operations.events("op_abc123")).rejects.toMatchObject({
      code: "internal_error",
      message: "malformed metal api response",
    });
  });

  it("returns an empty array for an operation event poll with no new events", async () => {
    const client = new MetalClient({
      baseUrl: "http://localhost:4000",
      accessToken: async () => "t",
      fetch: async () =>
        new Response("", { status: 200, headers: { "content-type": "text/event-stream" } }),
    });

    await expect(client.operations.events("op_abc123", { lastEventId: 6 })).resolves.toEqual([]);
  });

  it("does not retry POST writes", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(
        jsonResponse(503, {
          code: "service_unavailable",
          message: "try later",
          request_id: "r1",
          retryable: true,
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

  it("updates and deletes an organization", async () => {
    const requests: Array<{ method?: string; body?: string }> = [];
    const organizationId = "11111111-1111-4111-8111-111111111111";
    const client = new MetalClient({
      baseUrl: "http://localhost:4000",
      accessToken: async () => "t",
      fetch: async (_url, init) => {
        requests.push({ method: init?.method, body: init?.body?.toString() });
        if (init?.method === "PATCH") {
          return jsonResponse(200, {
            id: organizationId,
            name: "Renamed",
            slug: "renamed",
            created_at: "2026-08-20T00:00:00.000Z",
            updated_at: "2026-08-20T01:00:00.000Z",
          });
        }
        return jsonResponse(200, { id: organizationId, deleted: true });
      },
    });

    await expect(
      client.organizations.update(organizationId, { name: "Renamed", slug: "renamed" }),
    ).resolves.toMatchObject({ name: "Renamed", slug: "renamed" });
    await expect(
      client.organizations.delete(organizationId, {
        confirm_name: "Renamed",
        confirm_forfeit_balance: true,
      }),
    ).resolves.toEqual({ id: organizationId, deleted: true });
    expect(requests).toEqual([
      {
        method: "PATCH",
        body: JSON.stringify({ name: "Renamed", slug: "renamed" }),
      },
      {
        method: "DELETE",
        body: JSON.stringify({
          confirm_name: "Renamed",
          confirm_forfeit_balance: true,
        }),
      },
    ]);
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

  it("quotes credit purchases through the billing API", async () => {
    let captured: { url: string; method?: string } | undefined;
    const client = new MetalClient({
      baseUrl: "http://localhost:4000",
      accessToken: async () => "t",
      fetch: async (url, init) => {
        captured = { url: String(url), method: init?.method };
        return jsonResponse(200, {
          amount_usd: "100.00",
          credit_microusd: "100000000",
          fee_microusd: "5500000",
          total_microusd: "105500000",
          credit_usd: "100.00",
          fee_usd: "5.50",
          total_usd: "105.50",
          fee_rate: "0.055",
          min_fee_usd: "0.80",
        });
      },
    });
    await expect(
      client.billing.quote("11111111-1111-4111-8111-111111111111", "100.00"),
    ).resolves.toMatchObject({ total_usd: "105.50" });
    expect(captured?.method).toBe("GET");
    expect(captured?.url).toContain(
      "/v1/organizations/11111111-1111-4111-8111-111111111111/billing/quote",
    );
    expect(captured?.url).toContain("amount_usd=100.00");
  });
});
