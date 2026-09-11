import { z } from "zod";
import { EventTypeSchema } from "./events.js";
import { IsoDateTimeSchema, OpaqueIdSchema } from "./primitives.js";

export const WebhookEndpointIdSchema = OpaqueIdSchema;
export type WebhookEndpointId = z.infer<typeof WebhookEndpointIdSchema>;

export const WebhookDeliveryIdSchema = OpaqueIdSchema;
export type WebhookDeliveryId = z.infer<typeof WebhookDeliveryIdSchema>;

export const WebhookUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" || parsed.protocol === "http:";
    } catch {
      return false;
    }
  }, "webhook url must be an absolute http(s) URL");
export type WebhookUrl = z.infer<typeof WebhookUrlSchema>;

export const WebhookEventFilterSchema = z.array(EventTypeSchema).max(64);
export type WebhookEventFilter = z.infer<typeof WebhookEventFilterSchema>;

export const WebhookEndpointSchema = z.object({
  id: WebhookEndpointIdSchema,
  organization_id: OpaqueIdSchema,
  name: z.string().min(1).max(120),
  url: z.string().min(1).max(2048),
  event_types: z.array(z.string().min(1)),
  enabled: z.boolean(),
  secret_prefix: z.string().min(1).max(32),
  rotated_at: IsoDateTimeSchema.nullable(),
  last_delivery_at: IsoDateTimeSchema.nullable(),
  last_delivery_status: z.string().min(1).nullable(),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
  disabled_at: IsoDateTimeSchema.nullable(),
});
export type WebhookEndpoint = z.infer<typeof WebhookEndpointSchema>;

export const WebhookEndpointWithSecretSchema = WebhookEndpointSchema.extend({
  secret: z.string().startsWith("whsec_"),
});
export type WebhookEndpointWithSecret = z.infer<typeof WebhookEndpointWithSecretSchema>;

export const WebhookEndpointListResponseSchema = z.object({
  webhooks: z.array(WebhookEndpointSchema),
});
export type WebhookEndpointListResponse = z.infer<typeof WebhookEndpointListResponseSchema>;

export const CreateWebhookEndpointRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  url: WebhookUrlSchema,
  event_types: WebhookEventFilterSchema.optional().default([]),
  enabled: z.boolean().optional().default(true),
});
export type CreateWebhookEndpointRequest = z.infer<typeof CreateWebhookEndpointRequestSchema>;

export const UpdateWebhookEndpointRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    url: WebhookUrlSchema.optional(),
    event_types: WebhookEventFilterSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "at least one field must be updated");
export type UpdateWebhookEndpointRequest = z.infer<typeof UpdateWebhookEndpointRequestSchema>;

export const RotateWebhookSecretResponseSchema = WebhookEndpointWithSecretSchema;
export type RotateWebhookSecretResponse = z.infer<typeof RotateWebhookSecretResponseSchema>;

export const WebhookEndpointDeleteResponseSchema = z.object({
  id: WebhookEndpointIdSchema,
  deleted: z.literal(true),
});
export type WebhookEndpointDeleteResponse = z.infer<typeof WebhookEndpointDeleteResponseSchema>;

export const WebhookDeliveryStatusSchema = z.enum([
  "pending",
  "delivering",
  "succeeded",
  "retrying",
  "failed",
]);
export type WebhookDeliveryStatus = z.infer<typeof WebhookDeliveryStatusSchema>;

export const WebhookDeliverySchema = z.object({
  id: WebhookDeliveryIdSchema,
  endpoint_id: WebhookEndpointIdSchema,
  event_id: z.string().min(1),
  event_type: z.string().min(1),
  status: WebhookDeliveryStatusSchema,
  attempt_count: z.number().int().nonnegative(),
  next_attempt_at: IsoDateTimeSchema.nullable(),
  last_http_status: z.number().int().nullable(),
  last_error: z.string().nullable(),
  last_latency_ms: z.number().int().nullable(),
  is_test: z.boolean(),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
  delivered_at: IsoDateTimeSchema.nullable(),
});
export type WebhookDelivery = z.infer<typeof WebhookDeliverySchema>;

export const WebhookDeliveryListResponseSchema = z.object({
  deliveries: z.array(WebhookDeliverySchema),
});
export type WebhookDeliveryListResponse = z.infer<typeof WebhookDeliveryListResponseSchema>;

export const WebhookTestSendResponseSchema = WebhookDeliverySchema;
export type WebhookTestSendResponse = z.infer<typeof WebhookTestSendResponseSchema>;

export const WebhookRedeliverResponseSchema = WebhookDeliverySchema;
export type WebhookRedeliverResponse = z.infer<typeof WebhookRedeliverResponseSchema>;
