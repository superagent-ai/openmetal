import type { GpuJobLogEvent } from "@openmetal/sdk";

export type GpuJobLogStream = "stdout" | "stderr";

export type GpuJobLogSegment = { stream: GpuJobLogStream; text: string };

export type GpuJobLogState = {
  lastSequence: number;
  segments: GpuJobLogSegment[];
  truncatedAtBytes: number | null;
  decoders: Record<GpuJobLogStream, TextDecoder>;
};

export function createGpuJobLogState(): GpuJobLogState {
  return {
    lastSequence: 0,
    segments: [],
    truncatedAtBytes: null,
    decoders: { stdout: new TextDecoder(), stderr: new TextDecoder() },
  };
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Appends a batch in sequence order. Decoders are stateful so multi-byte characters split
 * across chunks decode correctly; events at or below `lastSequence` are skipped.
 */
export function appendGpuJobLogEvents(
  state: GpuJobLogState,
  events: readonly GpuJobLogEvent[],
): GpuJobLogState {
  let { lastSequence, truncatedAtBytes } = state;
  const segments = [...state.segments];
  for (const event of events) {
    if (event.sequence <= lastSequence) continue;
    lastSequence = event.sequence;
    if (event.type === "truncated") {
      truncatedAtBytes = event.data.limit_bytes;
      continue;
    }
    const text = state.decoders[event.type].decode(decodeBase64(event.data.data_base64), {
      stream: true,
    });
    if (!text) continue;
    const previous = segments.at(-1);
    if (previous?.stream === event.type) {
      segments[segments.length - 1] = { stream: event.type, text: previous.text + text };
    } else {
      segments.push({ stream: event.type, text });
    }
  }
  if (lastSequence === state.lastSequence) return state;
  return { ...state, lastSequence, segments, truncatedAtBytes };
}

export function gpuJobLogText(state: Pick<GpuJobLogState, "segments">): string {
  return state.segments.map((segment) => segment.text).join("");
}
