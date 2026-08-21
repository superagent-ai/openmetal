import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgSchema,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const organizationRoleEnum = pgEnum("organization_role", ["owner", "admin", "member"]);

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const organizationMembers = pgTable(
  "organization_members",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    role: organizationRoleEnum("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.userId] }),
    index("organization_members_user_id_idx").on(table.userId),
    index("organization_members_org_role_idx").on(table.organizationId, table.role),
  ],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("projects_organization_id_slug_key")
      .on(table.organizationId, table.slug)
      .where(sql`${table.deletedAt} is null`),
    index("projects_organization_id_idx").on(table.organizationId),
  ],
);

export const metalSchema = pgSchema("metal");

export const sandboxStatusEnum = metalSchema.enum("sandbox_status", [
  "requested",
  "provisioning",
  "ready",
  "pausing",
  "paused",
  "provision_unknown",
  "failed",
  "deleting",
  "deleted",
  "cleanup_pending",
  "cleanup_failed",
]);

export const projectApiKeys = metalSchema.table(
  "project_api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    secretHash: text("secret_hash").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("project_api_keys_secret_hash_key").on(table.secretHash),
    index("project_api_keys_project_id_idx").on(table.projectId, table.createdAt),
  ],
);

export const sandboxes = metalSchema.table(
  "sandboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    provider: text("provider").notNull().default("daytona"),
    providerResourceId: text("provider_resource_id"),
    providerOrganizationId: text("provider_organization_id"),
    providerMetadata: jsonb("provider_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    providerCostMicrousd: bigint("provider_cost_microusd", { mode: "bigint" }),
    providerCostMeasuredThrough: timestamp("provider_cost_measured_through", {
      withTimezone: true,
      mode: "date",
    }),
    providerCostUpdatedAt: timestamp("provider_cost_updated_at", {
      withTimezone: true,
      mode: "date",
    }),
    status: sandboxStatusEnum("status").notNull().default("requested"),
    image: text("image"),
    language: text("language").notNull().default("typescript"),
    ttlMinutes: integer("ttl_minutes").notNull().default(30),
    createdBy: uuid("created_by").notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    readyAt: timestamp("ready_at", { withTimezone: true, mode: "date" }),
    pausedAt: timestamp("paused_at", { withTimezone: true, mode: "date" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    index("sandboxes_project_created_idx").on(table.projectId, table.createdAt),
    uniqueIndex("sandboxes_provider_resource_key")
      .on(table.provider, table.providerResourceId)
      .where(sql`${table.providerResourceId} is not null`),
  ],
);

export const providerCostSnapshots = metalSchema.table(
  "provider_cost_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sandboxId: uuid("sandbox_id")
      .notNull()
      .references(() => sandboxes.id),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    provider: text("provider").notNull(),
    providerResourceId: text("provider_resource_id").notNull(),
    amountMicrousd: bigint("amount_microusd", { mode: "bigint" }).notNull(),
    measuredThrough: timestamp("measured_through", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    rawPayload: jsonb("raw_payload").$type<Record<string, unknown>>().notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("provider_cost_snapshots_sandbox_captured_idx").on(table.sandboxId, table.capturedAt),
    uniqueIndex("provider_cost_snapshots_unique_measurement").on(
      table.sandboxId,
      table.amountMicrousd,
      table.measuredThrough,
    ),
  ],
);

export const outboxJobStatusEnum = metalSchema.enum("outbox_job_status", [
  "pending",
  "leased",
  "succeeded",
  "failed",
]);

export const domainEvents = metalSchema.table(
  "domain_events",
  {
    cursor: bigint("cursor", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    eventId: uuid("event_id").notNull().defaultRandom(),
    type: text("type").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: uuid("project_id").references(() => projects.id),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    actorId: uuid("actor_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("domain_events_event_id_key").on(table.eventId),
    index("domain_events_project_cursor_idx").on(table.projectId, table.cursor),
    index("domain_events_org_cursor_idx").on(table.organizationId, table.cursor),
  ],
);

export const outboxJobs = metalSchema.table(
  "outbox_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobType: text("job_type").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: outboxJobStatusEnum("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "date" }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [uniqueIndex("outbox_jobs_dedupe_key_key").on(table.dedupeKey)],
);

export const idempotencyKeys = metalSchema.table(
  "idempotency_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    principalId: uuid("principal_id").notNull(),
    operation: text("operation").notNull(),
    keyHash: text("key_hash").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body").$type<unknown>(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idempotency_keys_scope_key").on(table.principalId, table.operation, table.keyHash),
  ],
);

export const schema = {
  organizations,
  organizationMembers,
  projects,
  projectApiKeys,
  sandboxes,
  domainEvents,
  outboxJobs,
  idempotencyKeys,
};
