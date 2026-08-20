import { z } from "zod";

export const API_VERSION = "v1" as const;
export const API_SEMVER = "1.0.0" as const;

export const OpaqueIdSchema = z.uuid();
export type OpaqueId = z.infer<typeof OpaqueIdSchema>;

export const IsoDateTimeSchema = z.iso.datetime();
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

export const PaginationLimitSchema = z.coerce.number().int().min(1).max(100);
export type PaginationLimit = z.infer<typeof PaginationLimitSchema>;

export const CursorSchema = z.string().min(1).max(512);
export type Cursor = z.infer<typeof CursorSchema>;

export const JsonObjectSchema = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof JsonObjectSchema>;
