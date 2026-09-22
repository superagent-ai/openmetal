import { z } from "zod";
import { OperationErrorSchema } from "./operations.js";
import {
  CursorSchema,
  IsoDateTimeSchema,
  PaginationLimitSchema,
  ProcessIdSchema,
  ProjectIdSchema,
  RuntimeOperationIdSchema,
  SandboxEndpointIdSchema,
  SandboxIdSchema,
  SandboxRecordingIdSchema,
} from "./primitives.js";
import { SandboxProviderSchema } from "./sandboxes.js";

export const DEFAULT_PROCESS_TIMEOUT_SECONDS = 300;
export const MAX_PROCESS_TIMEOUT_SECONDS = 3_600;
export const DEFAULT_PROCESS_OUTPUT_BYTES = 10 * 1_024 * 1_024;
export const MAX_PROCESS_OUTPUT_BYTES = 100 * 1_024 * 1_024;
export const MAX_PROCESS_ARGUMENTS = 4_096;
export const MAX_PROCESS_ARGUMENT_BYTES = 131_072;
export const DEFAULT_FILE_READ_BYTES = 1 * 1_024 * 1_024;
export const MAX_FILE_READ_BYTES = 10 * 1_024 * 1_024;
export const MAX_FILE_WRITE_BYTES = 10 * 1_024 * 1_024;
export const DEFAULT_FILE_LIST_ENTRIES = 1_000;
export const MAX_FILE_LIST_ENTRIES = 10_000;
export const DEFAULT_ENDPOINT_LEASE_SECONDS = 3_600;
export const MIN_ENDPOINT_LEASE_SECONDS = 60;
export const MAX_ENDPOINT_LEASE_SECONDS = 86_400;

const MAX_BASE64_WRITE_LENGTH = Math.ceil(MAX_FILE_WRITE_BYTES / 3) * 4;

function decodedBase64ByteLength(value: string): number {
  const paddingBytes = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - paddingBytes;
}

export const PortablePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .regex(/^\/(?:[^/\0]+(?:\/[^/\0]+)*)?$/)
  .refine(
    (path) => path.split("/").every((segment) => segment !== "." && segment !== ".."),
    "path must not contain relative traversal segments",
  );

export const Base64PayloadSchema = z
  .string()
  .max(MAX_BASE64_WRITE_LENGTH)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  .refine(
    (value) => decodedBase64ByteLength(value) <= MAX_FILE_WRITE_BYTES,
    `decoded payload must not exceed ${MAX_FILE_WRITE_BYTES} bytes`,
  );

export const ProviderRuntimeCapabilitiesSchema = z.object({
  provider: SandboxProviderSchema,
  version: z.string().min(1).max(100),
  lifecycle: z
    .object({
      pause: z.boolean(),
      resume: z.boolean(),
    })
    .optional(),
  process: z
    .object({
      execute: z.boolean(),
      cancel: z.boolean(),
      ordered_output: z.boolean(),
      max_timeout_seconds: z.number().int().positive().optional(),
      max_output_bytes: z.number().int().positive().optional(),
    })
    .optional(),
  filesystem: z
    .object({
      read: z.boolean(),
      write: z.boolean(),
      write_modes: z.array(z.enum(["create", "overwrite", "append"])),
      create_parents: z.boolean(),
      list: z.boolean(),
      delete: z.boolean(),
      max_read_bytes: z.number().int().positive().optional(),
      max_write_bytes: z.number().int().positive().optional(),
    })
    .optional(),
  http_endpoints: z
    .object({
      create: z.boolean(),
      revoke: z.boolean(),
      max_lease_seconds: z.number().int().positive().optional(),
    })
    .optional(),
  computer: z
    .object({
      implementation: z.enum(["native", "emulated"]),
      actions: z.array(
        z.enum([
          "mouse_move",
          "mouse_click",
          "mouse_drag",
          "mouse_scroll",
          "keyboard_type",
          "keyboard_key",
          "keyboard_hotkey",
        ]),
      ),
      screenshot: z
        .object({
          formats: z.array(z.enum(["png", "jpeg"])).min(1),
          max_bytes: z.number().int().positive(),
        })
        .optional(),
      recording: z
        .object({
          formats: z.array(z.enum(["mp4", "webm"])).min(1),
        })
        .optional(),
    })
    .optional(),
});
export type ProviderRuntimeCapabilities = z.infer<typeof ProviderRuntimeCapabilitiesSchema>;
export const SandboxCapabilitiesSchema = ProviderRuntimeCapabilitiesSchema;
export type SandboxCapabilities = z.infer<typeof SandboxCapabilitiesSchema>;

export const ProcessStateSchema = z.enum([
  "queued",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);
export type ProcessState = z.infer<typeof ProcessStateSchema>;

export const CreateProcessRequestSchema = z.object({
  command: z.array(z.string().max(MAX_PROCESS_ARGUMENT_BYTES)).min(1).max(MAX_PROCESS_ARGUMENTS),
  cwd: PortablePathSchema.optional(),
  environment: z.record(z.string().min(1).max(256), z.string().max(16_384)).optional(),
  timeout_seconds: z
    .number()
    .int()
    .min(1)
    .max(MAX_PROCESS_TIMEOUT_SECONDS)
    .default(DEFAULT_PROCESS_TIMEOUT_SECONDS),
  max_output_bytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_PROCESS_OUTPUT_BYTES)
    .default(DEFAULT_PROCESS_OUTPUT_BYTES),
});
export type CreateProcessRequest = z.infer<typeof CreateProcessRequestSchema>;

export const ProcessSchema = z.object({
  id: ProcessIdSchema,
  type: z.literal("process"),
  project_id: ProjectIdSchema,
  sandbox_id: SandboxIdSchema,
  state: ProcessStateSchema,
  command: z.array(z.string()),
  cwd: PortablePathSchema.nullable(),
  timeout_seconds: z.number().int().positive(),
  max_output_bytes: z.number().int().positive(),
  output_bytes: z.number().int().nonnegative(),
  output_truncated: z.boolean(),
  exit_code: z.number().int().nullable(),
  termination_signal: z.string().nullable(),
  error: OperationErrorSchema.nullable(),
  cancel_requested_at: IsoDateTimeSchema.nullable(),
  created_at: IsoDateTimeSchema,
  started_at: IsoDateTimeSchema.nullable(),
  completed_at: IsoDateTimeSchema.nullable(),
  provider_capabilities: ProviderRuntimeCapabilitiesSchema.optional(),
});
export type Process = z.infer<typeof ProcessSchema>;

const ProcessEventBaseSchema = z.object({
  sequence: z.number().int().positive(),
  process_id: ProcessIdSchema,
  occurred_at: IsoDateTimeSchema,
});
const ProcessOutputEventDataSchema = z
  .object({
    data_base64: Base64PayloadSchema,
    byte_length: z.number().int().nonnegative(),
    stream_offset_bytes: z.number().int().nonnegative(),
  })
  .superRefine((value, context) => {
    if (decodedBase64ByteLength(value.data_base64) !== value.byte_length) {
      context.addIssue({
        code: "custom",
        path: ["byte_length"],
        message: "byte_length must match the decoded data_base64 payload",
      });
    }
  });
export const ProcessEventSchema = z.discriminatedUnion("type", [
  ProcessEventBaseSchema.extend({
    type: z.literal("queued"),
    data: z.object({}),
  }),
  ProcessEventBaseSchema.extend({
    type: z.literal("started"),
    data: z.object({}),
  }),
  ProcessEventBaseSchema.extend({
    type: z.literal("stdout"),
    data: ProcessOutputEventDataSchema,
  }),
  ProcessEventBaseSchema.extend({
    type: z.literal("stderr"),
    data: ProcessOutputEventDataSchema,
  }),
  ProcessEventBaseSchema.extend({
    type: z.literal("exited"),
    data: z.object({
      exit_code: z.number().int(),
    }),
  }),
  ProcessEventBaseSchema.extend({
    type: z.literal("cancelled"),
    data: z.object({
      termination_signal: z.string().nullable(),
    }),
  }),
  ProcessEventBaseSchema.extend({
    type: z.literal("timed_out"),
    data: z.object({
      timeout_seconds: z.number().int().positive(),
      termination_signal: z.string().nullable(),
    }),
  }),
  ProcessEventBaseSchema.extend({
    type: z.literal("failed"),
    data: OperationErrorSchema,
  }),
]);
export type ProcessEvent = z.infer<typeof ProcessEventSchema>;

export const RuntimeOperationKindSchema = z.enum([
  "filesystem_read",
  "filesystem_write",
  "filesystem_list",
  "filesystem_delete",
  "computer_action",
  "computer_screenshot",
]);
export const RuntimeOperationStateSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const ReadFileRequestSchema = z.object({
  path: PortablePathSchema,
  offset_bytes: z.number().int().nonnegative().default(0),
  limit_bytes: z.number().int().min(1).max(MAX_FILE_READ_BYTES).default(DEFAULT_FILE_READ_BYTES),
});
export const WriteFileRequestSchema = z.object({
  path: PortablePathSchema,
  data_base64: Base64PayloadSchema,
  mode: z.enum(["create", "overwrite", "append"]).default("overwrite"),
  create_parents: z.boolean().default(false),
});
export const ListFilesRequestSchema = z.object({
  path: PortablePathSchema,
  recursive: z.boolean().default(false),
  max_entries: z
    .number()
    .int()
    .min(1)
    .max(MAX_FILE_LIST_ENTRIES)
    .default(DEFAULT_FILE_LIST_ENTRIES),
});
export const DeleteFileRequestSchema = z.object({
  path: PortablePathSchema,
  recursive: z.boolean().default(false),
});

const CoordinateSchema = z.number().int().nonnegative();
export const ComputerActionRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("mouse_move"),
    x: CoordinateSchema,
    y: CoordinateSchema,
  }),
  z.object({
    type: z.literal("mouse_click"),
    x: CoordinateSchema,
    y: CoordinateSchema,
    button: z.enum(["left", "right", "middle"]).default("left"),
    double: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("mouse_drag"),
    start_x: CoordinateSchema,
    start_y: CoordinateSchema,
    end_x: CoordinateSchema,
    end_y: CoordinateSchema,
    button: z.enum(["left", "right", "middle"]).default("left"),
  }),
  z.object({
    type: z.literal("mouse_scroll"),
    direction: z.enum(["up", "down"]),
    amount: z.number().int().positive().default(1),
    x: CoordinateSchema.optional(),
    y: CoordinateSchema.optional(),
  }),
  z.object({
    type: z.literal("keyboard_type"),
    text: z.string().max(100_000),
    delay_ms: z.number().int().nonnegative().max(60_000).default(0),
  }),
  z.object({
    type: z.literal("keyboard_key"),
    key: z.string().min(1).max(100),
    modifiers: z
      .array(z.enum(["ctrl", "alt", "shift", "cmd"]))
      .max(4)
      .default([]),
  }),
  z.object({
    type: z.literal("keyboard_hotkey"),
    keys: z.string().min(1).max(200),
  }),
]);

export const ComputerScreenshotRequestSchema = z.object({
  format: z.enum(["png", "jpeg"]).default("png"),
  show_cursor: z.boolean().default(false),
  quality: z.number().int().min(1).max(100).optional(),
  scale: z.number().min(0.1).max(1).optional(),
  region: z
    .object({
      x: CoordinateSchema,
      y: CoordinateSchema,
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .optional(),
});

export const ReadFileResultSchema = z.object({
  kind: z.literal("filesystem_read"),
  path: PortablePathSchema,
  data_base64: Base64PayloadSchema,
  offset_bytes: z.number().int().nonnegative(),
  byte_length: z.number().int().nonnegative(),
  eof: z.boolean(),
});
export const WriteFileResultSchema = z.object({
  kind: z.literal("filesystem_write"),
  path: PortablePathSchema,
  bytes_written: z.number().int().nonnegative(),
});
export const FileEntrySchema = z.object({
  path: PortablePathSchema,
  type: z.enum(["file", "directory", "symlink", "other"]),
  size_bytes: z.number().int().nonnegative().nullable(),
  modified_at: IsoDateTimeSchema.nullable(),
});
export const ListFilesResultSchema = z.object({
  kind: z.literal("filesystem_list"),
  path: PortablePathSchema,
  entries: z.array(FileEntrySchema).max(MAX_FILE_LIST_ENTRIES),
  truncated: z.boolean(),
});
export const DeleteFileResultSchema = z.object({
  kind: z.literal("filesystem_delete"),
  path: PortablePathSchema,
  deleted: z.boolean(),
});
export const ComputerActionResultSchema = z.object({
  kind: z.literal("computer_action"),
  performed: z.literal(true),
});
export const ComputerScreenshotResultSchema = z.object({
  kind: z.literal("computer_screenshot"),
  format: z.enum(["png", "jpeg"]),
  data_base64: Base64PayloadSchema,
  byte_length: z.number().int().nonnegative(),
  cursor_position: z
    .object({
      x: CoordinateSchema,
      y: CoordinateSchema,
    })
    .optional(),
});
export const RuntimeOperationResultSchema = z.discriminatedUnion("kind", [
  ReadFileResultSchema,
  WriteFileResultSchema,
  ListFilesResultSchema,
  DeleteFileResultSchema,
  ComputerActionResultSchema,
  ComputerScreenshotResultSchema,
]);

export const RuntimeOperationSchema = z
  .object({
    id: RuntimeOperationIdSchema,
    type: z.literal("runtime_operation"),
    project_id: ProjectIdSchema,
    sandbox_id: SandboxIdSchema,
    kind: RuntimeOperationKindSchema,
    state: RuntimeOperationStateSchema,
    result: RuntimeOperationResultSchema.nullable(),
    error: OperationErrorSchema.nullable(),
    created_at: IsoDateTimeSchema,
    started_at: IsoDateTimeSchema.nullable(),
    completed_at: IsoDateTimeSchema.nullable(),
    provider_capabilities: ProviderRuntimeCapabilitiesSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.result && value.result.kind !== value.kind) {
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "result kind must match the runtime operation kind",
      });
    }
  });
export type RuntimeOperation = z.infer<typeof RuntimeOperationSchema>;

export const SandboxEndpointStateSchema = z.enum([
  "provisioning",
  "active",
  "revoking",
  "revoked",
  "expired",
  "failed",
]);
export const CreateSandboxEndpointRequestSchema = z.object({
  port: z.number().int().min(1).max(65_535),
  protocol: z.literal("http").default("http"),
  lease_seconds: z
    .number()
    .int()
    .min(MIN_ENDPOINT_LEASE_SECONDS)
    .max(MAX_ENDPOINT_LEASE_SECONDS)
    .default(DEFAULT_ENDPOINT_LEASE_SECONDS),
});
export const SandboxEndpointSchema = z.object({
  id: SandboxEndpointIdSchema,
  type: z.literal("sandbox_endpoint"),
  project_id: ProjectIdSchema,
  sandbox_id: SandboxIdSchema,
  port: z.number().int().min(1).max(65_535),
  protocol: z.literal("http"),
  state: SandboxEndpointStateSchema,
  url: z
    .url()
    .refine((value) => value.startsWith("http://") || value.startsWith("https://"))
    .nullable(),
  lease_expires_at: IsoDateTimeSchema,
  revoked_at: IsoDateTimeSchema.nullable(),
  error: OperationErrorSchema.nullable(),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
  provider_capabilities: ProviderRuntimeCapabilitiesSchema.optional(),
});
export const ListSandboxEndpointsQuerySchema = z.object({
  cursor: CursorSchema.optional(),
  limit: PaginationLimitSchema.default(50),
});
export const SandboxEndpointListResponseSchema = z.object({
  endpoints: z.array(SandboxEndpointSchema),
  next_cursor: CursorSchema.nullable(),
});

export const SandboxRecordingStateSchema = z.enum([
  "starting",
  "recording",
  "stopping",
  "stopped",
  "failed",
]);
export const CreateSandboxRecordingRequestSchema = z.object({
  format: z.literal("mp4").default("mp4"),
  label: z.string().min(1).max(200).optional(),
});
export const SandboxRecordingArtifactSchema = z.object({
  kind: z.literal("sandbox_file"),
  path: PortablePathSchema,
  media_type: z.literal("video/mp4"),
});
export const SandboxRecordingSchema = z.object({
  id: SandboxRecordingIdSchema,
  type: z.literal("sandbox_recording"),
  project_id: ProjectIdSchema,
  sandbox_id: SandboxIdSchema,
  state: SandboxRecordingStateSchema,
  format: z.literal("mp4"),
  label: z.string().nullable(),
  artifact: SandboxRecordingArtifactSchema.nullable(),
  size_bytes: z.number().int().nonnegative().nullable(),
  duration_seconds: z.number().nonnegative().nullable(),
  error: OperationErrorSchema.nullable(),
  created_at: IsoDateTimeSchema,
  started_at: IsoDateTimeSchema.nullable(),
  stopped_at: IsoDateTimeSchema.nullable(),
  updated_at: IsoDateTimeSchema,
  provider_capabilities: ProviderRuntimeCapabilitiesSchema.optional(),
});
export const ListSandboxRecordingsQuerySchema = z.object({
  cursor: CursorSchema.optional(),
  limit: PaginationLimitSchema.default(50),
});
export const SandboxRecordingListResponseSchema = z.object({
  recordings: z.array(SandboxRecordingSchema),
  next_cursor: CursorSchema.nullable(),
});

export type ReadFileRequest = z.infer<typeof ReadFileRequestSchema>;
export type WriteFileRequest = z.infer<typeof WriteFileRequestSchema>;
export type ListFilesRequest = z.infer<typeof ListFilesRequestSchema>;
export type DeleteFileRequest = z.infer<typeof DeleteFileRequestSchema>;
export type ComputerActionRequest = z.infer<typeof ComputerActionRequestSchema>;
export type ComputerScreenshotRequest = z.infer<typeof ComputerScreenshotRequestSchema>;
export type RuntimeOperationKind = z.infer<typeof RuntimeOperationKindSchema>;
export type RuntimeOperationState = z.infer<typeof RuntimeOperationStateSchema>;
export type SandboxEndpointState = z.infer<typeof SandboxEndpointStateSchema>;
export type CreateSandboxEndpointRequest = z.infer<typeof CreateSandboxEndpointRequestSchema>;
export type SandboxEndpoint = z.infer<typeof SandboxEndpointSchema>;
export type ListSandboxEndpointsQuery = z.infer<typeof ListSandboxEndpointsQuerySchema>;
export type SandboxEndpointListResponse = z.infer<typeof SandboxEndpointListResponseSchema>;
export type SandboxRecordingState = z.infer<typeof SandboxRecordingStateSchema>;
export type CreateSandboxRecordingRequest = z.infer<typeof CreateSandboxRecordingRequestSchema>;
export type SandboxRecording = z.infer<typeof SandboxRecordingSchema>;
export type ListSandboxRecordingsQuery = z.infer<typeof ListSandboxRecordingsQuerySchema>;
export type SandboxRecordingListResponse = z.infer<typeof SandboxRecordingListResponseSchema>;
