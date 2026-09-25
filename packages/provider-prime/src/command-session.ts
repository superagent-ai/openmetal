// Connect's server-streaming protobuf envelope and the small subset of
// command_session.CommandSession used by Prime's VM gateway. Field numbers are
// pinned to Prime's command_session_pb2 at
// https://github.com/PrimeIntellect-ai/prime/tree/ef4d17614ebfeeb6596910240609ac694d8df3f4/packages/prime-sandboxes
import { ProviderError } from "@openmetal/provider-core";

const encoder = new TextEncoder();
const MAX_FRAME_BYTES = 16 * 1_024 * 1_024;

function varint(value: number): number[] {
  const bytes: number[] = [];
  do {
    const digit = value % 128;
    value = Math.floor(value / 128);
    bytes.push(digit | (value ? 128 : 0));
  } while (value);
  return bytes;
}

function field(number: number, value: Uint8Array | string): number[] {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return [...varint(number * 8 + 2), ...varint(bytes.length), ...bytes];
}

export function startCommandSession(
  command: readonly string[],
  cwd: string | undefined,
  environment: Readonly<Record<string, string>> | undefined,
  sessionId: string,
): Uint8Array {
  const spec = [
    ...field(1, "/bin/bash"),
    ...field(2, "-c"),
    ...field(2, `exec ${command.map((part) => `'${part.replaceAll("'", "'\"'\"'")}'`).join(" ")}`),
    ...Object.entries(environment ?? {}).flatMap(([key, value]) =>
      field(3, Uint8Array.from([...field(1, key), ...field(2, value)])),
    ),
    ...(cwd ? field(4, cwd) : []),
  ];
  return Uint8Array.from([...field(1, Uint8Array.from(spec)), ...field(5, sessionId)]);
}

export function connectEnvelope(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  new DataView(frame.buffer).setUint32(1, payload.length);
  frame.set(payload, 5);
  return frame;
}

function fields(
  bytes: Uint8Array,
): Array<{ number: number; bytes?: Uint8Array; integer?: number }> {
  let offset = 0;
  const items: Array<{ number: number; bytes?: Uint8Array; integer?: number }> = [];
  const readVarint = (): number => {
    let value = 0;
    let factor = 1;
    for (let i = 0; i < 10 && offset < bytes.length; i += 1) {
      const digit = bytes[offset++]!;
      value += (digit & 127) * factor;
      if (digit < 128 && Number.isSafeInteger(value)) return value;
      factor *= 128;
    }
    throw new ProviderError("invalid Prime command-session protobuf", "unknown_outcome", false);
  };
  while (offset < bytes.length) {
    const tag = readVarint();
    const number = Math.floor(tag / 8);
    if (!number) throw new ProviderError("invalid Prime protobuf field", "unknown_outcome", false);
    if (tag % 8 === 0) items.push({ number, integer: readVarint() });
    else if (tag % 8 === 2) {
      const length = readVarint();
      if (length > bytes.length - offset) {
        throw new ProviderError("invalid Prime protobuf length", "unknown_outcome", false);
      }
      items.push({ number, bytes: bytes.subarray(offset, offset + length) });
      offset += length;
    } else {
      throw new ProviderError("unexpected Prime protobuf wire type", "unknown_outcome", false);
    }
  }
  return items;
}

export type CommandEvent =
  { type: "stdout" | "stderr"; data: Uint8Array } | { type: "exit"; exitCode: number };

function parseEvent(bytes: Uint8Array): CommandEvent | undefined {
  const event = fields(bytes).find((item) => item.number === 1)?.bytes;
  if (!event) return undefined;
  for (const item of fields(event)) {
    if (item.number === 2 && item.bytes) {
      const data = fields(item.bytes).find((entry) => entry.number === 1 || entry.number === 2);
      if (data?.bytes) return { type: data.number === 1 ? "stdout" : "stderr", data: data.bytes };
    }
    if (item.number === 3 && item.bytes) {
      const endFields = fields(item.bytes);
      if (endFields.find((entry) => entry.number === 2)?.integer !== 1) {
        throw new ProviderError(
          "Prime process ended without an exit code",
          "unknown_outcome",
          false,
        );
      }
      const code = endFields.find((entry) => entry.number === 1)?.integer ?? 0;
      // EndEvent.exit_code is sint32 (ZigZag encoded).
      return { type: "exit", exitCode: code % 2 ? -(code + 1) / 2 : code / 2 };
    }
  }
  return undefined;
}

export async function* commandEvents(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<CommandEvent> {
  const reader = body.getReader();
  let buffer = new Uint8Array(0);
  let exited = false;
  let trailers = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const next = new Uint8Array(buffer.length + result.value.length);
      next.set(buffer);
      next.set(result.value, buffer.length);
      buffer = next;
      while (buffer.length >= 5) {
        const length = new DataView(buffer.buffer, buffer.byteOffset).getUint32(1);
        if (length > MAX_FRAME_BYTES) {
          throw new ProviderError("Prime command frame too large", "unknown_outcome", false);
        }
        if (buffer.length < 5 + length) break;
        const flags = buffer[0]!;
        const payload = buffer.slice(5, 5 + length);
        buffer = buffer.slice(5 + length);
        if (flags === 2) {
          trailers = true;
          const end = JSON.parse(new TextDecoder().decode(payload)) as { error?: unknown };
          if (end.error) {
            throw new ProviderError("Prime command stream failed", "unknown_outcome", false);
          }
        } else if (flags === 0) {
          const event = parseEvent(payload);
          if (event) {
            if (event.type === "exit") exited = true;
            yield event;
          }
        } else {
          throw new ProviderError("invalid Prime command frame", "unknown_outcome", false);
        }
      }
    }
    if (buffer.length || !trailers || !exited) {
      throw new ProviderError("Prime command stream ended before exit", "unknown_outcome", false);
    }
  } finally {
    await reader.cancel();
  }
}
