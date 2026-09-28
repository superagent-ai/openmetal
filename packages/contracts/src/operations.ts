import { z } from "zod";
import {
  GpuJobIdSchema,
  IsoDateTimeSchema,
  JsonObjectSchema,
  OperationIdSchema,
  ProjectIdSchema,
  SandboxIdSchema,
} from "./primitives.js";

export const OperationTypeSchema = z.enum([
  "sandbox_create",
  "sandbox_pause",
  "sandbox_resume",
  "sandbox_destroy",
  "gpu_job_create",
  "gpu_job_cancel",
]);
export const OperationResourceTypeSchema = z.enum(["sandbox", "gpu_job"]);
export const OperationStateSchema = z.enum([
  "queued",
  "running",
  "reconciling",
  "succeeded",
  "failed",
  "cancelled",
]);

export const OperationErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  details: JsonObjectSchema.optional(),
});

export const OperationSchema = z.object({
  id: OperationIdSchema,
  project_id: ProjectIdSchema,
  type: OperationTypeSchema,
  state: OperationStateSchema,
  resource_type: OperationResourceTypeSchema,
  resource_id: z.union([SandboxIdSchema, GpuJobIdSchema]),
  retryable: z.boolean(),
  error: OperationErrorSchema.nullable(),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
  completed_at: IsoDateTimeSchema.nullable(),
});

export const OperationEventSchema = z.object({
  sequence: z.number().int().positive(),
  operation_id: OperationIdSchema,
  type: z.enum([
    "queued",
    "routing",
    "attempt_started",
    "attempt_failed",
    "reconciling",
    "state_changed",
    "completed",
  ]),
  occurred_at: IsoDateTimeSchema,
  data: JsonObjectSchema,
});

export type Operation = z.infer<typeof OperationSchema>;
export type OperationState = z.infer<typeof OperationStateSchema>;
export type OperationType = z.infer<typeof OperationTypeSchema>;
export type OperationResourceType = z.infer<typeof OperationResourceTypeSchema>;
export type OperationEvent = z.infer<typeof OperationEventSchema>;
