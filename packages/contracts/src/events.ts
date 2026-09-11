import { z } from "zod";
import {
  CursorSchema,
  IsoDateTimeSchema,
  JsonObjectSchema,
  OpaqueIdSchema,
  PaginationLimitSchema,
  ProjectIdSchema,
} from "./primitives.js";

export const EventTypeValues = [
  "organization.created",
  "organization.updated",
  "organization.deleted",
  "organization.provider_credentials.configured",
  "organization.provider_credentials.rotated",
  "organization.provider_credentials.removed",
  "project.created",
  "project.deleted",
  "project.updated",
  "sandbox.requested",
  "sandbox.ready",
  "sandbox.paused",
  "sandbox.resumed",
  "sandbox.attempt_started",
  "sandbox.attempt_failed",
  "sandbox.cost_updated",
  "sandbox.failed",
  "sandbox.deleted",
  "process.queued",
  "process.started",
  "process.cancel_requested",
  "process.completed",
  "process.cancelled",
  "process.failed",
  "runtime_operation.completed",
  "runtime_operation.failed",
  "endpoint.created",
  "endpoint.revoked",
  "endpoint.expired",
  "endpoint.failed",
  "billing.credits_purchased",
  "billing.credits_granted",
  "billing.usage_charged",
  "billing.auto_topup_failed",
  "billing.spend_limit_reached",
  "webhook.test",
] as const;
export type EventTypeValue = (typeof EventTypeValues)[number];

export const EventTypeSchema = z.enum(EventTypeValues);
export type EventType = z.infer<typeof EventTypeSchema>;

export const DurableEventEnvelopeSchema = z.object({
  cursor: CursorSchema,
  event_id: OpaqueIdSchema,
  type: z.string().min(1),
  organization_id: OpaqueIdSchema,
  project_id: ProjectIdSchema.optional(),
  occurred_at: IsoDateTimeSchema,
  data: JsonObjectSchema,
});
export type DurableEventEnvelope = z.infer<typeof DurableEventEnvelopeSchema>;

export const CursorEventPageSchema = z.object({
  events: z.array(DurableEventEnvelopeSchema),
  next_cursor: CursorSchema.nullable(),
});
export type CursorEventPage = z.infer<typeof CursorEventPageSchema>;

export const ListEventsQuerySchema = z.object({
  project_id: ProjectIdSchema,
  after: CursorSchema.optional(),
  limit: PaginationLimitSchema.default(50),
});
export type ListEventsQuery = z.infer<typeof ListEventsQuerySchema>;
