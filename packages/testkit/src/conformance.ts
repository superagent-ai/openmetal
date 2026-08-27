import type {
  ProviderCreateSandboxInput,
  ProviderExecEvent,
  ProviderSandbox,
  SandboxProvider,
} from "@openmetal/provider-core";

export async function exerciseSandboxProvider(
  provider: SandboxProvider,
  input: ProviderCreateSandboxInput,
) {
  const created = await provider.create(input);
  const duplicate = await provider.create(input);
  if (duplicate.providerResourceId !== created.providerResourceId) {
    throw new Error("provider create is not idempotent by Metal sandbox ID");
  }
  if (provider.capabilities.pause) {
    await provider.pause(created.providerResourceId);
    if (provider.capabilities.resume && provider.resume) {
      await provider.resume(created.providerResourceId);
    }
  }
  const runtime = provider.capabilities.runtime
    ? await exerciseSandboxRuntime(provider, created)
    : null;
  const now = new Date();
  const cost = provider.capabilities.cost
    ? await provider.getCost({
        providerResourceId: created.providerResourceId,
        providerOrganizationId: created.providerOrganizationId,
        providerMetadata: created.providerMetadata,
        from: new Date(now.getTime() - 1_000),
        to: now,
      })
    : null;
  await provider.destroy(created.providerResourceId);
  await provider.destroy(created.providerResourceId);
  return { created, cost, runtime };
}

export async function exerciseSandboxRuntime(provider: SandboxProvider, sandbox: ProviderSandbox) {
  const providerResourceId = sandbox.providerResourceId;
  const process = provider.capabilities.runtime?.process;
  let execEvents: ProviderExecEvent[] | null = null;
  let cancellationEvents: ProviderExecEvent[] | null = null;
  if (process?.exec || process?.streams) {
    requireCapabilityMethod(process.exec, provider.exec, "exec");
    requireCapabilityMethod(process.streams, provider.exec, "exec stream");
    const execution = await provider.exec({
      providerResourceId,
      command: ["sh", "-lc", "printf 'fake stdout'; printf 'fake stderr' >&2"],
      maxOutputBytes: process.maxOutputBytes,
    });
    execEvents = await collectExecEvents(execution.events);
    assertOrderedExecEvents(execEvents);

    if (process.cancel) {
      requireCapabilityMethod(true, provider.cancelExec, "cancelExec");
      const cancellable = await provider.exec({
        providerResourceId,
        command: ["sh", "-lc", "printf 'started'; sleep 30"],
      });
      const iterator = cancellable.events[Symbol.asyncIterator]();
      const first = await iterator.next();
      const cancelled = await provider.cancelExec({
        providerResourceId,
        executionId: cancellable.executionId,
      });
      if (!cancelled.cancelled) {
        throw new Error("provider did not cancel an active execution");
      }
      cancellationEvents = [
        ...(first.done ? [] : [first.value]),
        ...(await collectExecEvents({ [Symbol.asyncIterator]: () => iterator })),
      ];
      assertOrderedExecEvents(cancellationEvents);
      const exit = cancellationEvents.at(-1);
      if (exit?.type !== "exit" || !exit.cancelled) {
        throw new Error("cancelled execution did not end with a cancelled exit event");
      }
    }
  }

  const files = provider.capabilities.runtime?.files;
  let listedPaths: string[] | null = null;
  if (files) {
    const textPath = "/tmp/metal-conformance.txt";
    const binaryPath = "/tmp/metal-conformance.bin";
    const text = "metal runtime";
    const binary = Uint8Array.from([0, 1, 127, 128, 255]);
    if (files.write) {
      if (!files.writeModes.includes("overwrite")) {
        throw new Error("provider write capability omits the default overwrite mode");
      }
      requireCapabilityMethod(true, provider.writeFile, "writeFile");
      await provider.writeFile({
        providerResourceId,
        path: textPath,
        data: text,
        mode: "overwrite",
        createParents: files.createParents,
      });
      await provider.writeFile({
        providerResourceId,
        path: binaryPath,
        data: binary,
        mode: "overwrite",
        createParents: files.createParents,
      });
    } else if (files.writeModes.length > 0 || files.createParents) {
      throw new Error("provider declares write details while file writes are disabled");
    }
    if (files.read && files.write) {
      requireCapabilityMethod(true, provider.readFile, "readFile");
      const textResult = await provider.readFile({
        providerResourceId,
        path: textPath,
        encoding: "utf8",
      });
      const binaryResult = await provider.readFile({
        providerResourceId,
        path: binaryPath,
        encoding: "binary",
      });
      if (textResult.data !== text) {
        throw new Error("provider did not round-trip UTF-8 file content");
      }
      if (!(binaryResult.data instanceof Uint8Array) || !equalBytes(binaryResult.data, binary)) {
        throw new Error("provider did not round-trip binary file content");
      }
    }
    if (files.list && files.write) {
      requireCapabilityMethod(true, provider.listFiles, "listFiles");
      const listed = await provider.listFiles({
        providerResourceId,
        path: "/tmp",
        maxEntries: files.maxListEntries,
      });
      listedPaths = listed.entries.map((entry) => entry.path);
      if (!listedPaths.includes(textPath) || !listedPaths.includes(binaryPath)) {
        throw new Error("provider file listing omitted conformance files");
      }
    }
    if (files.delete && files.write) {
      requireCapabilityMethod(true, provider.deleteFile, "deleteFile");
      const deleted = await provider.deleteFile({ providerResourceId, path: textPath });
      const duplicate = await provider.deleteFile({ providerResourceId, path: textPath });
      if (!deleted.deleted || duplicate.deleted) {
        throw new Error("provider file deletion is not idempotent");
      }
      await provider.deleteFile({ providerResourceId, path: binaryPath });
    }
  }

  const endpoints = provider.capabilities.runtime?.httpEndpoints;
  let endpointUrl: string | null = null;
  if (endpoints?.expose) {
    requireCapabilityMethod(true, provider.exposeHttpEndpoint, "exposeHttpEndpoint");
    const lease = await provider.exposeHttpEndpoint({
      providerResourceId,
      port: 3_000,
      path: "/health",
      leaseDurationSeconds: Math.min(endpoints.maxLeaseDurationSeconds ?? 60, 60),
    });
    endpointUrl = lease.url;
    if (endpoints.revoke) {
      requireCapabilityMethod(true, provider.revokeHttpEndpoint, "revokeHttpEndpoint");
      const revoked = await provider.revokeHttpEndpoint({
        providerResourceId,
        leaseId: lease.leaseId,
      });
      const duplicate = await provider.revokeHttpEndpoint({
        providerResourceId,
        leaseId: lease.leaseId,
      });
      if (!revoked.revoked || duplicate.revoked) {
        throw new Error("provider endpoint revocation is not idempotent");
      }
    }
  }

  return { execEvents, cancellationEvents, listedPaths, endpointUrl };
}

export async function collectExecEvents(
  events: AsyncIterable<ProviderExecEvent>,
): Promise<ProviderExecEvent[]> {
  const collected: ProviderExecEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

export function assertOrderedExecEvents(events: readonly ProviderExecEvent[]): void {
  if (events.length === 0) throw new Error("provider exec stream was empty");
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]?.sequence !== index) {
      throw new Error("provider exec stream sequence is not contiguous");
    }
    if (events[index]?.type === "exit" && index !== events.length - 1) {
      throw new Error("provider exec emitted events after exit");
    }
  }
  if (events.at(-1)?.type !== "exit") {
    throw new Error("provider exec stream did not end with an exit event");
  }
}

function requireCapabilityMethod(
  advertised: boolean,
  method: ((...args: never[]) => unknown) | undefined,
  capability: string,
): asserts method is (...args: never[]) => unknown {
  if (advertised && !method) {
    throw new Error(`provider advertises ${capability} without implementing it`);
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
}
