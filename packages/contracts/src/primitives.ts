import { z } from "zod";

export const API_VERSION = "v1" as const;
export const API_SEMVER = "1.0.0" as const;

export const OpaqueIdSchema = z.uuid();
export type OpaqueId = z.infer<typeof OpaqueIdSchema>;

export const ProjectIdSchema = z.string().regex(/^prj_[A-Za-z0-9]+$/);
export const SandboxIdSchema = z.string().regex(/^sbx_[A-Za-z0-9]+$/);
export const OperationIdSchema = z.string().regex(/^op_[A-Za-z0-9]+$/);
export const ProcessIdSchema = z.string().regex(/^proc_[A-Za-z0-9]+$/);
export const RuntimeOperationIdSchema = z.string().regex(/^rop_[A-Za-z0-9]+$/);
export const SandboxEndpointIdSchema = z.string().regex(/^ep_[A-Za-z0-9]+$/);
export const SandboxRecordingIdSchema = z.string().regex(/^rec_[A-Za-z0-9]+$/);
export type ProjectId = z.infer<typeof ProjectIdSchema>;
export type SandboxId = z.infer<typeof SandboxIdSchema>;
export type OperationId = z.infer<typeof OperationIdSchema>;
export type ProcessId = z.infer<typeof ProcessIdSchema>;
export type RuntimeOperationId = z.infer<typeof RuntimeOperationIdSchema>;
export type SandboxEndpointId = z.infer<typeof SandboxEndpointIdSchema>;
export type SandboxRecordingId = z.infer<typeof SandboxRecordingIdSchema>;

export const IsoDateTimeSchema = z.iso.datetime();
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

export const PaginationLimitSchema = z.coerce.number().int().min(1).max(100);
export type PaginationLimit = z.infer<typeof PaginationLimitSchema>;

export const CursorSchema = z.string().min(1).max(512);
export type Cursor = z.infer<typeof CursorSchema>;

export const JsonObjectSchema = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof JsonObjectSchema>;
