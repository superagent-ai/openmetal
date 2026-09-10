import { afterAll, describe, expect, it } from "vitest";
import type {
  ProviderExecEvent,
  ProviderHttpEndpointLease,
  SandboxProvider,
  SandboxProviderName,
} from "@openmetal/provider-core";
import { loadWorkerEnv } from "../src/env.js";
import { loadRootEnv } from "../src/load-root-env.js";
import { buildSandboxProviders } from "../src/provider-registry.js";

loadRootEnv();

const providerNames = [
  "blaxel",
  "cloudflare",
  "codesandbox",
  "daytona",
  "e2b",
  "freestyle",
  "modal",
  "northflank",
  "runloop",
  "vercel",
] as const satisfies readonly SandboxProviderName[];
const enabled = process.env.METAL_LIVE_TESTS === "1";
const liveTimeoutMs = positiveInteger(process.env.METAL_LIVE_TIMEOUT_MS, 300_000);
const operationTimeoutMs = positiveInteger(process.env.METAL_LIVE_OPERATION_TIMEOUT_MS, 60_000);
const cleanupTimeoutMs = positiveInteger(process.env.METAL_LIVE_CLEANUP_TIMEOUT_MS, 60_000);
const httpTimeoutMs = positiveInteger(process.env.METAL_LIVE_HTTP_TIMEOUT_MS, 60_000);
const env = enabled
  ? loadWorkerEnv({
      DATABASE_URL: "postgresql://live-test.invalid/unused",
      SUPABASE_URL: "https://live-test.invalid",
      SUPABASE_SECRET_KEY: "live-test-unused",
      WORKER_ID: "provider-live-test",
      ...process.env,
    })
  : undefined;
const providers = env ? buildSandboxProviders(env) : {};
const requestedProviders = new Set(
  (process.env.METAL_LIVE_PROVIDERS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const unknownRequested = [...requestedProviders].filter(
  (name) => !providerNames.includes(name as SandboxProviderName),
);
const selected = providerNames.filter(
  (name) => requestedProviders.size === 0 || requestedProviders.has(name),
);
const missingCredentials = new Map(
  selected.flatMap((name) => {
    const missing = missingCredentialNames(name, process.env);
    return missing.length === 0 ? [] : ([[name, missing]] as const);
  }),
);
const exercised = new Set<SandboxProviderName>();

(enabled ? describe.sequential : describe.skip)("live sandbox provider conformance", () => {
  afterAll(() => {
    const skipped = selected
      .filter((name) => !providers[name] || missingCredentials.has(name))
      .map((name) => `${name} (${missingCredentials.get(name)?.join(", ") ?? "not configured"})`);
    const incomplete = selected.filter(
      (name) => providers[name] && !missingCredentials.has(name) && !exercised.has(name),
    );
    console.info(
      [
        `[metal live] exercised: ${[...exercised].join(", ") || "none"}`,
        `[metal live] skipped: ${skipped.join("; ") || "none"}`,
        `[metal live] configured but incomplete: ${incomplete.join(", ") || "none"}`,
      ].join("\n"),
    );
  });

  it("recognizes every requested provider", () => {
    expect(unknownRequested).toEqual([]);
  });

  for (const name of selected) {
    const provider = providers[name];
    const missing = missingCredentials.get(name);
    const run = provider && !missing ? it : it.skip;
    run(
      `${name}: declared lifecycle and runtime capabilities${
        missing ? ` (missing ${missing.join(", ")})` : ""
      }`,
      async () => {
        const runId = crypto.randomUUID().replaceAll("-", "");
        const metalSandboxId = `sbx_live${runId}`;
        const marker = `metal-live-${name}-${runId}`;
        const serverPort = 30_000 + Math.floor(Math.random() * 10_000);
        const serverScript = httpServerScript(serverPort, marker);
        let providerResourceId: string | undefined;
        let providerOrganizationId: string | undefined;
        let providerMetadata: Record<string, unknown> | undefined;
        const cleanupFilePaths: string[] = [];
        const endpointCleanup: {
          lease?: ProviderHttpEndpointLease;
          revoked: boolean;
        } = { revoked: false };
        const failures: unknown[] = [];
        const startedAt = new Date();
        assertRuntimeCapabilityDeclarations(provider!);

        try {
          const endpointOnly =
            provider!.capabilities.runtime?.httpEndpoints?.expose === true &&
            provider!.capabilities.runtime.process?.exec !== true;
          const created = await liveStep(name, "create", () =>
            provider!.create({
              metalSandboxId,
              organizationId: "11111111-1111-4111-8111-111111111111",
              projectId: "22222222-2222-4222-8222-222222222222",
              ...(endpointOnly && name === "northflank" ? { image: "node:22-alpine" } : {}),
              language: "typescript",
              ttlMinutes: 10,
              source: {
                kind: "environment",
                environment: "metal/node",
                version: "live",
                ...(endpointOnly ? { command: ["node", "-e", serverScript] } : {}),
              },
              resources: {
                vcpu: 0.5,
                memoryMb: 512,
                architecture: "any",
              },
              lifecycle: {
                runtimeTimeoutSeconds: 600,
                onRuntimeTimeout: "destroy",
                onIdleTimeout: "destroy",
              },
              providerOptions: {},
              environment: {
                METAL_LIVE_TEST: "1",
                METAL_LIVE_RUN_ID: runId,
                METAL_LIVE_PROVIDER: name,
              },
              secretRefs: {},
              metadata: {
                "metal.live_test": "1",
                "metal.run_id": runId,
                "metal.provider": name,
              },
              signal: AbortSignal.timeout(liveTimeoutMs),
            }),
          );
          providerResourceId = created.providerResourceId;
          providerOrganizationId = created.providerOrganizationId;
          providerMetadata = created.providerMetadata;
          expect(providerResourceId).toBeTruthy();
          if (created.resolvedResources) {
            expect(created.resolvedResources.vcpu).toBeGreaterThanOrEqual(0.5);
            expect(created.resolvedResources.memoryMb).toBeGreaterThanOrEqual(512);
          }
          if (provider!.capabilities.pause) {
            await liveStep(name, "pause", () =>
              provider!.pause(providerResourceId!, operationSignal()),
            );
            if (provider!.capabilities.resume && provider!.resume) {
              await liveStep(name, "resume", () =>
                provider!.resume!(providerResourceId!, operationSignal()),
              );
            }
          }
          if (provider!.capabilities.cost) {
            const cost = await liveStep(name, "cost", () =>
              provider!.getCost({
                providerResourceId: providerResourceId!,
                providerOrganizationId,
                providerMetadata,
                from: startedAt,
                to: new Date(),
                signal: operationSignal(),
              }),
            );
            if (cost) expect(cost.amountMicrousd).toBeGreaterThanOrEqual(0n);
          }

          await liveStep(name, "process", () =>
            exerciseProcess(provider!, providerResourceId!, marker),
          );
          await liveStep(name, "files", () =>
            exerciseFiles(provider!, providerResourceId!, runId, marker, cleanupFilePaths),
          );
          await liveStep(name, "endpoint", () =>
            exerciseHttpEndpoint(
              provider!,
              providerResourceId!,
              serverPort,
              marker,
              serverScript,
              endpointCleanup,
            ),
          );
        } catch (error) {
          failures.push(error);
        } finally {
          if (!providerResourceId && provider!.reconcileCreate) {
            try {
              const reconciled = await liveStep(name, "reconcile cleanup", () =>
                provider!.reconcileCreate!(metalSandboxId, cleanupSignal()),
              );
              providerResourceId = reconciled?.providerResourceId;
            } catch (error) {
              failures.push(new Error(`${name} reconcile cleanup failed`, { cause: error }));
            }
          }
          if (providerResourceId) {
            if (
              endpointCleanup.lease &&
              !endpointCleanup.revoked &&
              provider!.capabilities.runtime?.httpEndpoints?.revoke &&
              provider!.revokeHttpEndpoint
            ) {
              try {
                await liveStep(name, "endpoint cleanup", () =>
                  provider!.revokeHttpEndpoint!({
                    providerResourceId: providerResourceId!,
                    leaseId: endpointCleanup.lease!.leaseId,
                    ...cleanupOperation(),
                  }),
                );
              } catch (error) {
                failures.push(new Error(`${name} endpoint cleanup failed`, { cause: error }));
              }
            }
            if (provider!.capabilities.runtime?.files?.delete && provider!.deleteFile) {
              for (const path of cleanupFilePaths) {
                try {
                  await liveStep(name, "file cleanup", () =>
                    provider!.deleteFile!({
                      providerResourceId: providerResourceId!,
                      path,
                      ...cleanupOperation(),
                    }),
                  );
                } catch (error) {
                  failures.push(
                    new Error(`${name} file cleanup failed for ${path}`, { cause: error }),
                  );
                }
              }
            }
            for (let attempt = 1; attempt <= 2; attempt += 1) {
              try {
                await liveStep(name, `destroy ${attempt}`, () =>
                  provider!.destroy(providerResourceId!, cleanupSignal()),
                );
              } catch (error) {
                failures.push(
                  new Error(`${name} destroy attempt ${attempt} failed`, { cause: error }),
                );
              }
            }
            if (provider!.reconcileCreate) {
              try {
                const remaining = await liveStep(name, "verify cleanup", () =>
                  provider!.reconcileCreate!(metalSandboxId, cleanupSignal()),
                );
                expect(remaining, `${name} tagged resource remained after destroy`).toBeNull();
              } catch (error) {
                failures.push(new Error(`${name} cleanup verification failed`, { cause: error }));
              }
            }
          }
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, `${name} live provider acceptance failed`);
        }
        exercised.add(name);
      },
      liveTimeoutMs + cleanupTimeoutMs * 3,
    );
  }
});

async function exerciseProcess(
  provider: SandboxProvider,
  providerResourceId: string,
  marker: string,
): Promise<void> {
  const processCapabilities = provider.capabilities.runtime?.process;
  if (!processCapabilities?.exec) return;

  const stdoutMarker = `${marker}-stdout`;
  const stderrMarker = `${marker}-stderr`;
  const execution = await liveStep(provider.name, "process exec", () =>
    provider.exec!({
      providerResourceId,
      command: [
        "sh",
        "-lc",
        `printf '%s' '${stdoutMarker}'; printf '%s' '${stderrMarker}' >&2; exit 7`,
      ],
      environment: {},
      maxOutputBytes: Math.min(processCapabilities.maxOutputBytes, 16_384),
      ...runtimeOperation(),
    }),
  );
  const events = await liveStep(provider.name, "process output", () =>
    collectExecEvents(execution.events),
  );
  assertExecEvents(events);
  expect(decodeEvents(events, "stdout")).toContain(stdoutMarker);
  expect(decodeEvents(events, "stderr")).toContain(stderrMarker);
  expect(events.at(-1)).toMatchObject({
    type: "exit",
    exitCode: 7,
    cancelled: false,
    outputTruncated: false,
  });

  if (!processCapabilities.cancel) return;
  const cancellable = await liveStep(provider.name, "cancel exec", () =>
    provider.exec!({
      providerResourceId,
      command: ["sh", "-lc", `printf '%s' '${marker}-started'; sleep 120`],
      ...runtimeOperation(),
    }),
  );
  const iterator = cancellable.events[Symbol.asyncIterator]();
  const first = processCapabilities.streams
    ? await liveStep(provider.name, "cancel first output", () =>
        withTimeout(iterator.next(), operationTimeoutMs, "first cancellation event"),
      )
    : undefined;
  if (first) {
    expect(first.done).toBe(false);
    expect(first.value?.type).toBe("stdout");
  }
  const restartSafeCancellation = provider.name === "runloop" || provider.name === "vercel";
  const cancellingProvider =
    restartSafeCancellation && env ? buildSandboxProviders(env)[provider.name]! : provider;
  const cancelled = await liveStep(provider.name, "cancel request", () =>
    cancellingProvider.cancelExec!({
      providerResourceId,
      executionId: cancellable.executionId,
      ...runtimeOperation(),
    }),
  );
  expect(cancelled).toEqual({ executionId: cancellable.executionId, cancelled: true });
  const remaining = await liveStep(provider.name, "cancel output", () =>
    withTimeout(
      collectExecEvents({ [Symbol.asyncIterator]: () => iterator }),
      operationTimeoutMs,
      "cancelled execution exit",
    ),
  );
  const cancellationEvents = [...(first && !first.done ? [first.value] : []), ...remaining];
  assertExecEvents(cancellationEvents);
  expect(cancellationEvents.at(-1)).toMatchObject(
    restartSafeCancellation ? { type: "exit" } : { type: "exit", cancelled: true },
  );
}

async function exerciseFiles(
  provider: SandboxProvider,
  providerResourceId: string,
  runId: string,
  marker: string,
  written: string[],
): Promise<void> {
  const files = provider.capabilities.runtime?.files;
  if (!files) return;
  const textPath = `/workspace/metal-live-${runId}.txt`;
  const binaryPath = `/workspace/metal-live-${runId}.bin`;
  const binary = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);

  if (files.write) {
    expect(files.writeModes).toContain("overwrite");
    await provider.writeFile!({
      providerResourceId,
      path: textPath,
      data: marker,
      mode: "overwrite",
      createParents: files.createParents,
      ...runtimeOperation(),
    });
    written.push(textPath);
    await provider.writeFile!({
      providerResourceId,
      path: binaryPath,
      data: binary,
      mode: "overwrite",
      createParents: files.createParents,
      ...runtimeOperation(),
    });
    written.push(binaryPath);
  }
  if (files.read && files.write) {
    const text = await provider.readFile!({
      providerResourceId,
      path: textPath,
      encoding: "utf8",
      maxBytes: Math.min(files.maxReadBytes, 16_384),
      ...runtimeOperation(),
    });
    const binaryResult = await provider.readFile!({
      providerResourceId,
      path: binaryPath,
      encoding: "binary",
      maxBytes: Math.min(files.maxReadBytes, 16_384),
      ...runtimeOperation(),
    });
    expect(text.data).toBe(marker);
    expect(text).toMatchObject({ eof: true, truncated: false });
    expect(binaryResult.data).toEqual(binary);
    expect(binaryResult).toMatchObject({ eof: true, truncated: false });
  }
  if (files.list && files.write) {
    const listed = await provider.listFiles!({
      providerResourceId,
      path: "/workspace",
      maxEntries: Math.min(files.maxListEntries, 1_000),
      ...runtimeOperation(),
    });
    const paths = listed.entries.map((entry) => entry.path);
    expect(paths).toContain(textPath);
    expect(paths).toContain(binaryPath);
  }
  if (files.delete && files.write) {
    for (const path of [...written]) {
      expect(
        await provider.deleteFile!({ providerResourceId, path, ...runtimeOperation() }),
      ).toEqual({ path, deleted: true });
      expect(
        await provider.deleteFile!({ providerResourceId, path, ...runtimeOperation() }),
      ).toEqual({ path, deleted: false });
      written.splice(written.indexOf(path), 1);
    }
  }
}

async function exerciseHttpEndpoint(
  provider: SandboxProvider,
  providerResourceId: string,
  port: number,
  marker: string,
  serverScript: string,
  cleanup: { lease?: ProviderHttpEndpointLease; revoked: boolean },
): Promise<void> {
  const endpoints = provider.capabilities.runtime?.httpEndpoints;
  if (!endpoints?.expose) return;

  if (provider.capabilities.runtime?.process?.exec) {
    const started = await provider.exec!({
      providerResourceId,
      command: [
        "sh",
        "-lc",
        `nohup node -e ${shellQuote(serverScript)} >/tmp/${marker}.http.log 2>&1 &`,
      ],
      ...runtimeOperation(),
    });
    const events = await collectExecEvents(started.events);
    assertExecEvents(events);
    expect(events.at(-1)).toMatchObject({ type: "exit", exitCode: 0, cancelled: false });
  }

  const lease = await provider.exposeHttpEndpoint!({
    providerResourceId,
    port,
    path: "/metal-live",
    leaseDurationSeconds: Math.min(endpoints.maxLeaseDurationSeconds ?? 30, 30),
    ...runtimeOperation(),
  });
  cleanup.lease = lease;
  expect(lease.expiresAt.getTime()).toBeGreaterThan(Date.now());
  expect(await fetchTextWithRetry(lease.url)).toBe(marker);

  if (endpoints.revoke) {
    const restartedProvider = env ? buildSandboxProviders(env)[provider.name] : undefined;
    const revoker = restartedProvider ?? provider;
    expect(
      await revoker.revokeHttpEndpoint!({
        providerResourceId,
        leaseId: lease.leaseId,
        ...runtimeOperation(),
      }),
    ).toEqual({ leaseId: lease.leaseId, revoked: true });
    cleanup.revoked = true;
    await expectEndpointUnreachable(lease.url);
  }
}

function assertRuntimeCapabilityDeclarations(provider: SandboxProvider): void {
  const runtime = provider.capabilities.runtime;
  const declarations = [
    ["exec", runtime?.process?.exec, provider.exec],
    ["cancelExec", runtime?.process?.cancel, provider.cancelExec],
    ["readFile", runtime?.files?.read, provider.readFile],
    ["writeFile", runtime?.files?.write, provider.writeFile],
    ["listFiles", runtime?.files?.list, provider.listFiles],
    ["deleteFile", runtime?.files?.delete, provider.deleteFile],
    ["exposeHttpEndpoint", runtime?.httpEndpoints?.expose, provider.exposeHttpEndpoint],
    ["revokeHttpEndpoint", runtime?.httpEndpoints?.revoke, provider.revokeHttpEndpoint],
  ] as const;
  for (const [name, declared, method] of declarations) {
    expect(typeof method === "function", `${provider.name} ${name} declaration`).toBe(
      declared === true,
    );
  }
  expect(
    runtime?.process?.streams === true && runtime.process.exec !== true,
    `${provider.name} cannot stream without exec`,
  ).toBe(false);
  expect(
    runtime?.process?.cancel === true && runtime.process.exec !== true,
    `${provider.name} cannot cancel without exec`,
  ).toBe(false);
  expect(
    runtime?.httpEndpoints?.revoke === true && runtime.httpEndpoints.expose !== true,
    `${provider.name} cannot revoke undeclared endpoints`,
  ).toBe(false);
  if (runtime?.files) {
    expect(
      runtime.files.write === false &&
        (runtime.files.writeModes.length > 0 || runtime.files.createParents),
      `${provider.name} cannot declare write details when writes are disabled`,
    ).toBe(false);
    if (runtime.files.write) {
      expect(runtime.files.writeModes).toContain("overwrite");
    }
  }
}

function assertExecEvents(events: readonly ProviderExecEvent[]): void {
  expect(events.length).toBeGreaterThan(0);
  expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index));
  expect(events.at(-1)?.type).toBe("exit");
  expect(events.slice(0, -1).every((event) => event.type !== "exit")).toBe(true);
}

async function collectExecEvents(events: AsyncIterable<ProviderExecEvent>) {
  const result: ProviderExecEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function decodeEvents(events: readonly ProviderExecEvent[], type: "stdout" | "stderr"): string {
  return events
    .filter((event) => event.type === type)
    .map((event) => new TextDecoder().decode(event.data))
    .join("");
}

async function fetchTextWithRetry(url: string): Promise<string> {
  const deadline = Date.now() + httpTimeoutMs;
  let lastError: unknown;
  do {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(operationTimeoutMs) });
      if (response.ok) return await response.text();
      lastError = new Error(`endpoint returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  } while (Date.now() < deadline);
  throw new Error(`endpoint did not become reachable within ${httpTimeoutMs}ms`, {
    cause: lastError,
  });
}

async function expectEndpointUnreachable(url: string): Promise<void> {
  const deadline = Date.now() + httpTimeoutMs;
  do {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(operationTimeoutMs) });
      if (!response.ok) return;
      await response.body?.cancel();
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  } while (Date.now() < deadline);
  throw new Error(`revoked endpoint remained reachable for ${httpTimeoutMs}ms`);
}

function runtimeOperation() {
  return {
    deadline: new Date(Date.now() + operationTimeoutMs),
    signal: operationSignal(),
  };
}

function cleanupOperation() {
  return {
    deadline: new Date(Date.now() + cleanupTimeoutMs),
    signal: cleanupSignal(),
  };
}

function operationSignal(): AbortSignal {
  return AbortSignal.timeout(operationTimeoutMs);
}

function cleanupSignal(): AbortSignal {
  return AbortSignal.timeout(cleanupTimeoutMs);
}

function httpServerScript(port: number, marker: string): string {
  return `require("http").createServer((request,response)=>{if(request.url!=="/metal-live"){response.writeHead(404);response.end();return}response.writeHead(200,{"content-type":"text/plain"});response.end(${JSON.stringify(
    marker,
  )})}).listen(${port},"0.0.0.0")`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      timer.unref();
    }),
  ]);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`live provider timeout must be a positive integer, received ${value}`);
  }
  return parsed;
}

async function liveStep<T>(
  provider: SandboxProviderName,
  operation: string,
  run: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  console.info(`[metal live] ${provider} ${operation}: started`);
  try {
    const result = await run();
    console.info(
      `[metal live] ${provider} ${operation}: completed in ${Math.round(performance.now() - started)}ms`,
    );
    return result;
  } catch (error) {
    throw new Error(
      `[metal live] ${provider} ${operation} failed after ${Math.round(performance.now() - started)}ms`,
      { cause: error },
    );
  }
}

function missingCredentialNames(
  provider: SandboxProviderName,
  source: NodeJS.ProcessEnv,
): string[] {
  const requirements: Record<SandboxProviderName, readonly (readonly string[])[]> = {
    blaxel: [
      ["BL_API_KEY", "BLAXEL_API_KEY"],
      ["BL_WORKSPACE", "BLAXEL_WORKSPACE"],
    ],
    cloudflare: [["CLOUDFLARE_SANDBOX_API_URL"], ["CLOUDFLARE_SANDBOX_API_KEY"]],
    codesandbox: [["CODESANDBOX_API_KEY"]],
    daytona: [["DAYTONA_API_KEY"]],
    e2b: [["E2B_API_KEY"]],
    freestyle: [["FREESTYLE_API_KEY"]],
    modal: [["MODAL_TOKEN_ID"], ["MODAL_TOKEN_SECRET"]],
    northflank: [["NORTHFLANK_API_TOKEN"], ["NORTHFLANK_PROJECT_ID"]],
    runloop: [["RUNLOOP_API_KEY"]],
    vercel: [["VERCEL_OIDC_TOKEN", "VERCEL_TOKEN"], ["VERCEL_PROJECT_ID"]],
  };
  return requirements[provider]
    .filter((alternatives) => !alternatives.some((name) => usableCredential(source[name])))
    .map((alternatives) => alternatives.join("|"));
}

function usableCredential(value: string | undefined): boolean {
  return Boolean(
    value &&
    !value.includes("replace-with") &&
    !value.includes("your-sandbox") &&
    !value.includes("example.com"),
  );
}
