import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
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

export const organizationInvitations = pgTable(
  "organization_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: organizationRoleEnum("role").notNull(),
    invitedBy: uuid("invited_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "date" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("organization_invitations_pending_email_key")
      .on(table.organizationId, table.email)
      .where(sql`${table.acceptedAt} is null and ${table.revokedAt} is null`),
    index("organization_invitations_organization_id_idx").on(table.organizationId, table.createdAt),
    index("organization_invitations_email_idx")
      .on(table.email)
      .where(sql`${table.acceptedAt} is null and ${table.revokedAt} is null`),
  ],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id")
      .notNull()
      .default(sql`'prj_' || replace(gen_random_uuid()::text, '-', '')`),
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
    uniqueIndex("projects_public_id_key").on(table.publicId),
    index("projects_organization_id_idx").on(table.organizationId),
  ],
);

export const metalSchema = pgSchema("metal");

export const sandboxStatusEnum = metalSchema.enum("sandbox_status", [
  "requested",
  "routing",
  "provisioning",
  "provision_unknown",
  "ready",
  "pausing",
  "paused",
  "resuming",
  "runtime_unknown",
  "stopping",
  "stopped",
  "failed",
  // Legacy values remain valid while existing rows are migrated.
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

export const organizationProviderCredentials = metalSchema.table(
  "organization_provider_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    secretId: uuid("secret_id").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    disabledAt: timestamp("disabled_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("organization_provider_credentials_organization_id_provider_key").on(
      table.organizationId,
      table.provider,
    ),
    index("organization_provider_credentials_organization_idx").on(
      table.organizationId,
      table.provider,
    ),
    index("organization_provider_credentials_active_idx")
      .on(table.organizationId, table.provider)
      .where(sql`${table.disabledAt} is null`),
  ],
);

export const sandboxes = metalSchema.table(
  "sandboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id")
      .notNull()
      .default(sql`'sbx_' || replace(gen_random_uuid()::text, '-', '')`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    provider: text("provider").notNull().default("daytona"),
    primaryProvider: text("primary_provider").notNull().default("daytona"),
    providerCredentialId: uuid("provider_credential_id").references(
      () => organizationProviderCredentials.id,
    ),
    billingMode: text("billing_mode").notNull().default("managed"),
    providerResourceId: text("provider_resource_id"),
    providerOrganizationId: text("provider_organization_id"),
    providerMetadata: jsonb("provider_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    source: jsonb("source").$type<Record<string, unknown>>().notNull().default({}),
    resourceRequirements: jsonb("resource_requirements")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    resolvedResources: jsonb("resolved_resources").$type<Record<string, unknown>>(),
    lifecycle: jsonb("lifecycle").$type<Record<string, unknown>>().notNull().default({}),
    regions: jsonb("regions").$type<string[]>().notNull().default([]),
    features: jsonb("features").$type<Record<string, unknown>>().notNull().default({}),
    network: jsonb("network").$type<Record<string, unknown>>().notNull().default({}),
    fallback: jsonb("fallback").$type<Record<string, unknown>>().notNull().default({}),
    providerOptions: jsonb("provider_options")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    environment: jsonb("environment").$type<Record<string, string>>().notNull().default({}),
    secretRefs: jsonb("secret_refs").$type<Record<string, string>>().notNull().default({}),
    metadata: jsonb("metadata").$type<Record<string, string>>().notNull().default({}),
    providerCostMicrousd: bigint("provider_cost_microusd", { mode: "bigint" }),
    providerCostMeasuredThrough: timestamp("provider_cost_measured_through", {
      withTimezone: true,
      mode: "date",
    }),
    providerCostUpdatedAt: timestamp("provider_cost_updated_at", {
      withTimezone: true,
      mode: "date",
    }),
    customerChargedMicrousd: bigint("customer_charged_microusd", { mode: "bigint" })
      .notNull()
      .default(0n),
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
    uniqueIndex("sandboxes_public_id_key").on(table.publicId),
    uniqueIndex("sandboxes_provider_resource_key")
      .on(table.provider, table.providerResourceId)
      .where(sql`${table.providerResourceId} is not null`),
    index("sandboxes_provider_credential_id_idx")
      .on(table.providerCredentialId)
      .where(sql`${table.providerCredentialId} is not null`),
  ],
);

export const operations = metalSchema.table(
  "operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id")
      .notNull()
      .default(sql`'op_' || replace(gen_random_uuid()::text, '-', '')`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    sandboxId: uuid("sandbox_id")
      .notNull()
      .references(() => sandboxes.id),
    type: text("type").notNull(),
    state: text("state").notNull().default("queued"),
    retryable: boolean("retryable").notNull().default(false),
    error: jsonb("error").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("operations_public_id_key").on(table.publicId),
    index("operations_project_created_idx").on(table.projectId, table.createdAt),
    index("operations_sandbox_created_idx").on(table.sandboxId, table.createdAt),
  ],
);

export const operationEvents = metalSchema.table(
  "operation_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operationId: uuid("operation_id")
      .notNull()
      .references(() => operations.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("operation_events_operation_sequence_key").on(table.operationId, table.sequence),
  ],
);

export const providerAttempts = metalSchema.table(
  "provider_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operationId: uuid("operation_id")
      .notNull()
      .references(() => operations.id, { onDelete: "cascade" }),
    sandboxId: uuid("sandbox_id")
      .notNull()
      .references(() => sandboxes.id),
    attemptIndex: integer("attempt_index").notNull(),
    provider: text("provider").notNull(),
    providerCredentialId: uuid("provider_credential_id").references(
      () => organizationProviderCredentials.id,
    ),
    state: text("state").notNull().default("queued"),
    providerResourceId: text("provider_resource_id"),
    providerMetadata: jsonb("provider_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    resolvedResources: jsonb("resolved_resources").$type<Record<string, unknown>>(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    outcome: text("outcome"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_attempts_operation_index_key").on(table.operationId, table.attemptIndex),
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

export const pricingKindEnum = metalSchema.enum("pricing_kind", ["purchase_fee", "usage"]);
export const creditPurchaseSourceEnum = metalSchema.enum("credit_purchase_source", [
  "checkout",
  "auto_topup",
  "admin_grant",
]);
export const creditPurchaseStatusEnum = metalSchema.enum("credit_purchase_status", [
  "pending",
  "paid",
  "failed",
  "canceled",
  "requires_action",
]);
export const autoTopupStatusEnum = metalSchema.enum("auto_topup_status", [
  "disabled",
  "active",
  "paused",
]);
export const autoTopupAttemptStatusEnum = metalSchema.enum("auto_topup_attempt_status", [
  "pending",
  "succeeded",
  "failed",
  "requires_action",
]);
export const ledgerTransactionKindEnum = metalSchema.enum("ledger_transaction_kind", [
  "deposit",
  "usage_charge",
  "usage_correction",
  "adjustment",
]);
export const ledgerAccountEnum = metalSchema.enum("ledger_account", [
  "customer_credits",
  "platform_clearing",
]);

export const pricingVersions = metalSchema.table("pricing_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  kind: pricingKindEnum("kind").notNull(),
  feePerMille: integer("fee_per_mille").notNull().default(0),
  minFeeMicrousd: bigint("min_fee_microusd", { mode: "bigint" }).notNull().default(0n),
  effectiveFrom: timestamp("effective_from", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const billingAccounts = metalSchema.table(
  "billing_accounts",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    stripeCustomerId: text("stripe_customer_id"),
    stripePaymentMethodId: text("stripe_payment_method_id"),
    paymentMethodBrand: text("payment_method_brand"),
    paymentMethodLast4: text("payment_method_last4"),
    balanceMicrousd: bigint("balance_microusd", { mode: "bigint" }).notNull().default(0n),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("billing_accounts_stripe_customer_id_key")
      .on(table.stripeCustomerId)
      .where(sql`${table.stripeCustomerId} is not null`),
  ],
);

export const autoTopupPolicies = metalSchema.table("auto_topup_policies", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  status: autoTopupStatusEnum("status").notNull().default("disabled"),
  thresholdMicrousd: bigint("threshold_microusd", { mode: "bigint" })
    .notNull()
    .default(10_000_000n),
  refillMicrousd: bigint("refill_microusd", { mode: "bigint" }).notNull().default(50_000_000n),
  monthlyCapMicrousd: bigint("monthly_cap_microusd", { mode: "bigint" })
    .notNull()
    .default(500_000_000n),
  pausedReason: text("paused_reason"),
  updatedBy: uuid("updated_by"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const creditPurchases = metalSchema.table(
  "credit_purchases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    source: creditPurchaseSourceEnum("source").notNull(),
    status: creditPurchaseStatusEnum("status").notNull().default("pending"),
    creditMicrousd: bigint("credit_microusd", { mode: "bigint" }).notNull(),
    feeMicrousd: bigint("fee_microusd", { mode: "bigint" }).notNull(),
    totalMicrousd: bigint("total_microusd", { mode: "bigint" }).notNull(),
    pricingVersionId: uuid("pricing_version_id")
      .notNull()
      .references(() => pricingVersions.id),
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    stripeCustomerId: text("stripe_customer_id"),
    actorId: uuid("actor_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    paidAt: timestamp("paid_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("credit_purchases_stripe_checkout_session_id_key")
      .on(table.stripeCheckoutSessionId)
      .where(sql`${table.stripeCheckoutSessionId} is not null`),
    uniqueIndex("credit_purchases_stripe_payment_intent_id_key")
      .on(table.stripePaymentIntentId)
      .where(sql`${table.stripePaymentIntentId} is not null`),
    index("credit_purchases_organization_created_idx").on(table.organizationId, table.createdAt),
  ],
);

export const autoTopupAttempts = metalSchema.table(
  "auto_topup_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    purchaseId: uuid("purchase_id")
      .notNull()
      .references(() => creditPurchases.id, { onDelete: "cascade" }),
    status: autoTopupAttemptStatusEnum("status").notNull().default("pending"),
    windowStart: timestamp("window_start", { withTimezone: true, mode: "date" }).notNull(),
    creditMicrousd: bigint("credit_microusd", { mode: "bigint" }).notNull(),
    feeMicrousd: bigint("fee_microusd", { mode: "bigint" }).notNull(),
    totalMicrousd: bigint("total_microusd", { mode: "bigint" }).notNull(),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("auto_topup_attempts_purchase_id_key").on(table.purchaseId),
    index("auto_topup_attempts_org_window_idx").on(
      table.organizationId,
      table.windowStart,
      table.status,
    ),
    uniqueIndex("auto_topup_attempts_pending_org_key")
      .on(table.organizationId)
      .where(sql`${table.status} = 'pending'`),
  ],
);

export const stripeEvents = metalSchema.table("stripe_events", {
  eventId: text("event_id").primaryKey(),
  type: text("type").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export const ledgerTransactions = metalSchema.table(
  "ledger_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: ledgerTransactionKindEnum("kind").notNull(),
    referenceType: text("reference_type").notNull(),
    referenceId: uuid("reference_id").notNull(),
    description: text("description").notNull(),
    actorId: uuid("actor_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("ledger_transactions_organization_created_idx").on(table.organizationId, table.createdAt),
  ],
);

export const ledgerEntries = metalSchema.table(
  "ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => ledgerTransactions.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    account: ledgerAccountEnum("account").notNull(),
    amountMicrousd: bigint("amount_microusd", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("ledger_entries_transaction_idx").on(table.transactionId),
    index("ledger_entries_organization_created_idx").on(table.organizationId, table.createdAt),
  ],
);

export const usageCharges = metalSchema.table(
  "usage_charges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sandboxId: uuid("sandbox_id")
      .notNull()
      .references(() => sandboxes.id, { onDelete: "cascade" }),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => providerCostSnapshots.id),
    pricingVersionId: uuid("pricing_version_id")
      .notNull()
      .references(() => pricingVersions.id),
    providerCostDeltaMicrousd: bigint("provider_cost_delta_microusd", { mode: "bigint" }).notNull(),
    customerChargeMicrousd: bigint("customer_charge_microusd", { mode: "bigint" }).notNull(),
    measuredFrom: timestamp("measured_from", { withTimezone: true, mode: "date" }),
    measuredThrough: timestamp("measured_through", { withTimezone: true, mode: "date" }).notNull(),
    ledgerTransactionId: uuid("ledger_transaction_id")
      .notNull()
      .references(() => ledgerTransactions.id),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("usage_charges_snapshot_id_key").on(table.snapshotId),
    index("usage_charges_sandbox_created_idx").on(table.sandboxId, table.createdAt),
  ],
);

export const schema = {
  organizations,
  organizationMembers,
  organizationInvitations,
  projects,
  projectApiKeys,
  organizationProviderCredentials,
  sandboxes,
  operations,
  operationEvents,
  providerAttempts,
  providerCostSnapshots,
  domainEvents,
  outboxJobs,
  idempotencyKeys,
  pricingVersions,
  billingAccounts,
  autoTopupPolicies,
  creditPurchases,
  autoTopupAttempts,
  stripeEvents,
  ledgerTransactions,
  ledgerEntries,
  usageCharges,
};
