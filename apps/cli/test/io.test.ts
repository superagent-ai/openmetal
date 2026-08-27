import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { confirm, writeResult, type CliIo } from "../src/io.js";

function testIo(tty: boolean): { io: CliIo; stdout: PassThrough; stderr: PassThrough } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(stdout, { isTTY: tty });
  Object.assign(stderr, { isTTY: tty });
  const stdin = Readable.from([]) as unknown as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: tty });
  return {
    io: {
      stdin,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
    },
    stdout,
    stderr,
  };
}

describe("CLI I/O", () => {
  it("renders tables for terminal arrays", () => {
    const { io, stdout } = testIo(true);
    writeResult(io, [{ id: "prj_1", state: "ready" }]);
    expect(stdout.read()?.toString()).toContain("ID");
    expect(stdout.read()?.toString() ?? "").not.toContain("undefined");
  });

  it("renders compact JSON when piped", () => {
    const { io, stdout } = testIo(false);
    writeResult(io, { status: "ok" });
    expect(stdout.read()?.toString()).toBe('{"status":"ok"}\n');
  });

  it("requires --yes for non-interactive destructive actions", async () => {
    const { io } = testIo(false);
    await expect(confirm(io, "Delete project")).rejects.toThrow("--yes");
    await expect(confirm(io, "Delete project", { yes: true })).resolves.toBeUndefined();
  });
});
