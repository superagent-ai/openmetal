import { expect, it, vi } from "vitest";
import type { ProviderExecEvent } from "@openmetal/provider-core";
import { RunloopSandboxProvider } from "../src/index.js";

it("declares the Runloop provider contract", () => {
  const provider = new RunloopSandboxProvider({ apiKey: "test" });
  expect(provider.name).toBe("runloop");
  expect(provider.capabilities.resume).toBe(true);
  expect(provider.capabilities.runtime).toEqual({
    process: {
      exec: true,
      streams: false,
      cancel: true,
      maxOutputBytes: 10 * 1_024 * 1_024,
    },
    files: {
      read: true,
      write: true,
      writeModes: ["create", "overwrite"],
      createParents: false,
      list: false,
      delete: false,
      maxReadBytes: 10 * 1_024 * 1_024,
      maxWriteBytes: 10 * 1_024 * 1_024,
      maxListEntries: 0,
    },
  });
  expect(provider.listFiles).toBeUndefined();
  expect(provider.deleteFile).toBeUndefined();
  expect(provider.exposeHttpEndpoint).toBeUndefined();
  expect(provider.revokeHttpEndpoint).toBeUndefined();
});

it.each([
  {
    usageRatesMicrousd: { vcpuHour: 100n, memoryGbHour: 200n, diskGbHour: 300n },
    provenance: "provider_metered",
    confidence: "medium",
    source: "runloop-resource-usage-oem-rate-card",
  },
  {
    usageRatesMicrousd: undefined,
    provenance: "estimated_rate_card",
    confidence: "low",
    source: "runloop-resource-usage-published-preset-rate",
  },
] as const)(
  "maps Runloop $provenance cost provenance",
  async ({ usageRatesMicrousd, provenance, confidence, source }) => {
    const usage = {
      id: "devbox-1",
      total_active_seconds: 60,
      total_elapsed_seconds: 60,
      vcpu_seconds: 60,
      memory_gb_seconds: 120,
      disk_gb_seconds: 180,
      start_time_ms: Date.parse("2026-08-27T10:00:00.000Z"),
      end_time_ms: Date.parse("2026-08-27T10:01:00.000Z"),
    };
    const provider = new RunloopSandboxProvider({
      apiKey: "test",
      ...(usageRatesMicrousd ? { usageRatesMicrousd } : {}),
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse(usage)),
    });

    const cost = await provider.getCost({
      providerResourceId: "devbox-1",
      providerOrganizationId: "account-1",
      from: new Date("2026-08-27T10:00:00.000Z"),
      to: new Date("2026-08-27T10:01:00.000Z"),
    });

    expect(cost).toMatchObject({
      provenance,
      confidence,
      source,
      raw: { usage },
    });
  },
);

it("streams normalized command output and a terminal exit", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const value = String(url);
    requests.push({ url: value, init });
    if (value.endsWith("/execute_async")) {
      return jsonResponse({
        devbox_id: "devbox-1",
        execution_id: "exec-1",
        status: "running",
      });
    }
    return jsonResponse({
      devbox_id: "devbox-1",
      execution_id: "exec-1",
      status: "completed",
      stdout: "hello",
      stderr: "warning",
      exit_status: 7,
      stdout_truncated: false,
      stderr_truncated: false,
    });
  }) as typeof fetch;
  const provider = new RunloopSandboxProvider({ apiKey: "test", fetchImpl });
  const result = await provider.exec({
    providerResourceId: "devbox-1",
    command: ["printf", "%s", "a'b"],
    cwd: "/tmp/work",
    environment: { MESSAGE: "hello world" },
    maxOutputBytes: 8,
  });
  const events = await collect(result.events);

  expect(result.executionId).toBe("exec-1");
  expect(events.map((event) => event.type)).toEqual(["stdout", "stderr", "exit"]);
  expect(events.map((event) => event.sequence)).toEqual([0, 1, 2]);
  expect(decodeOutput(events[0])).toBe("hello");
  expect(decodeOutput(events[1])).toBe("war");
  expect(events[1]).toMatchObject({ truncated: true });
  expect(events[2]).toMatchObject({
    type: "exit",
    exitCode: 7,
    cancelled: false,
    outputTruncated: true,
  });
  const createBody = JSON.parse(String(requests[0]?.init?.body)) as { command: string };
  expect(createBody.command).toContain("cd -- '/tmp/work'");
  expect(createBody.command).toContain("'MESSAGE=hello world'");
  expect(createBody.command).toContain("'a'\"'\"'b'");
});

it("cancels and confirms asynchronous executions after adapter restart", async () => {
  let killed = false;
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const value = String(url);
    if (value.endsWith("/execute_async")) {
      return jsonResponse({
        devbox_id: "devbox-1",
        execution_id: "exec-2",
        status: "running",
      });
    }
    if (value.endsWith("/kill")) {
      killed = true;
      return new Response(null, { status: 204 });
    }
    return jsonResponse({
      devbox_id: "devbox-1",
      execution_id: "exec-2",
      status: killed ? "completed" : "running",
      exit_status: killed ? 137 : null,
    });
  }) as typeof fetch;
  const provider = new RunloopSandboxProvider({ apiKey: "test", fetchImpl });
  await provider.exec({ providerResourceId: "devbox-1", command: ["sleep", "30"] });
  const restarted = new RunloopSandboxProvider({ apiKey: "test", fetchImpl });

  await expect(
    restarted.cancelExec({ providerResourceId: "devbox-1", executionId: "exec-2" }),
  ).resolves.toEqual({ executionId: "exec-2", cancelled: true });
  expect(fetchImpl.mock.calls[1]?.[0]).toContain("/executions/exec-2/kill");
  expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({
    kill_process_group: true,
  });
  expect(fetchImpl.mock.calls[2]?.[0]).toContain("/executions/exec-2");
});

it("performs bounded binary file reads and multipart writes", async () => {
  let downloadCalls = 0;
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const value = String(url);
    if (value.endsWith("/download_file")) {
      downloadCalls += 1;
      if (downloadCalls === 1) return new Response(null, { status: 404 });
      const bytes = Uint8Array.from([0, 1, 2, 3, 4]);
      return new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } });
    }
    if (value.endsWith("/upload_file")) {
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init?.body as FormData;
      expect(form.get("path")).toBe("tmp/data.bin");
      expect(await (form.get("file") as Blob).arrayBuffer()).toEqual(
        Uint8Array.from([8, 9]).buffer,
      );
      return jsonResponse({});
    }
    throw new Error(`unexpected request: ${value}`);
  }) as typeof fetch;
  const provider = new RunloopSandboxProvider({ apiKey: "test", fetchImpl });

  await expect(
    provider.writeFile({
      providerResourceId: "devbox-1",
      path: "/tmp/data.bin",
      data: Uint8Array.from([8, 9]),
    }),
  ).resolves.toEqual({ path: "/tmp/data.bin", bytesWritten: 2, created: true });
  await expect(
    provider.readFile({
      providerResourceId: "devbox-1",
      path: "/tmp/data.bin",
      offsetBytes: 1,
      maxBytes: 2,
    }),
  ).resolves.toMatchObject({
    path: "/tmp/data.bin",
    data: Uint8Array.from([1, 2]),
    offsetBytes: 1,
    byteLength: 2,
    sizeBytes: 5,
    eof: false,
    truncated: true,
  });
  await expect(
    provider.writeFile({
      providerResourceId: "devbox-1",
      path: "/tmp/data.bin",
      data: "x",
      mode: "append",
    }),
  ).rejects.toMatchObject({ kind: "unsupported" });
});

it("rejects expired runtime deadlines before transport", async () => {
  const fetchImpl = vi.fn() as unknown as typeof fetch;
  const provider = new RunloopSandboxProvider({ apiKey: "test", fetchImpl });
  await expect(
    provider.readFile({
      providerResourceId: "devbox-1",
      path: "/tmp/data",
      deadline: new Date(0),
    }),
  ).rejects.toMatchObject({ kind: "timeout_absent" });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it.each(["deadline", "abort"] as const)(
  "kills the Runloop process when an execution %s interrupts polling",
  async (interruption) => {
    const requests: string[] = [];
    const controller = new AbortController();
    let killed = false;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      requests.push(value);
      if (value.endsWith("/execute_async")) {
        return jsonResponse({
          devbox_id: "devbox-1",
          execution_id: "exec-deadline",
          status: "running",
        });
      }
      if (value.includes("/stream_")) return new Response("");
      if (value.endsWith("/kill")) {
        killed = true;
        return jsonResponse({
          devbox_id: "devbox-1",
          execution_id: "exec-deadline",
          status: "running",
        });
      }
      if (killed) {
        return jsonResponse({
          devbox_id: "devbox-1",
          execution_id: "exec-deadline",
          status: "completed",
          exit_status: 137,
        });
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }) as typeof fetch;
    const provider = new RunloopSandboxProvider({ apiKey: "test", fetchImpl });
    const execution = await provider.exec({
      providerResourceId: "devbox-1",
      command: ["sleep", "30"],
      ...(interruption === "deadline"
        ? { deadline: new Date(Date.now() + 20) }
        : { signal: controller.signal }),
    });
    if (interruption === "abort") setTimeout(() => controller.abort(), 20);

    await expect(collect(execution.events)).rejects.toBeDefined();
    expect(requests.some((request) => request.endsWith("/executions/exec-deadline/kill"))).toBe(
      true,
    );
    expect(
      requests.filter((request) => request.endsWith("/executions/exec-deadline")).length,
    ).toBeGreaterThanOrEqual(2);
  },
);

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

async function collect(events: AsyncIterable<ProviderExecEvent>): Promise<ProviderExecEvent[]> {
  const result: ProviderExecEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function decodeOutput(event: ProviderExecEvent | undefined): string | undefined {
  return event?.type === "stdout" || event?.type === "stderr"
    ? new TextDecoder().decode(event.data)
    : undefined;
}
