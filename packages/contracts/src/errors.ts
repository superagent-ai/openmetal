import { z } from "zod";
import { JsonObjectSchema } from "./primitives.js";

export const ErrorCodeSchema = z.enum([
  "unauthenticated",
  "forbidden",
  "validation_error",
  "not_found",
  "conflict",
  "idempotency_mismatch",
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
