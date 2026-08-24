import { z } from "zod";
import { JsonObjectSchema } from "./primitives.js";

export const ErrorCodeSchema = z.enum([
  "unauthenticated",
  "forbidden",
  "validation_error",
  "not_found",
  "conflict",
  "idempotency_mismatch",
  "idempotency_conflict",
  "capability_unsupported",
  "no_eligible_provider",
  "provider_auth_error",
  "provider_quota_exceeded",
  "provider_capacity_unavailable",
  "provider_timeout",
  "provider_unavailable",
  "provider_unknown_outcome",
  "invalid_sandbox_state",
  "unsupported_operation",
  "sandbox_not_ready",
  "sandbox_terminal",
  "timeout",
  "internal_error",
  "service_unavailable",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorEnvelopeSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  request_id: z.string().min(1),
  details: JsonObjectSchema.optional(),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
