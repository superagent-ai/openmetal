import { ErrorEnvelopeSchema, type ErrorEnvelope } from "@openmetal/contracts";

export class MetalError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  readonly idempotencyKey?: string;

  constructor(input: {
    message: string;
    status: number;
    code: string;
    requestId: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
    idempotencyKey?: string;
  }) {
    super(input.message);
    this.name = "MetalError";
    this.status = input.status;
    this.code = input.code;
    this.requestId = input.requestId;
    this.retryable = input.retryable ?? false;
    this.details = input.details;
    this.idempotencyKey = input.idempotencyKey;
  }

  static fromEnvelope(
    status: number,
    envelope: ErrorEnvelope,
    idempotencyKey?: string,
  ): MetalError {
    return new MetalError({
      status,
      message: envelope.message,
      code: envelope.code,
      requestId: envelope.request_id,
      retryable: envelope.retryable,
      details: envelope.details,
      idempotencyKey,
    });
  }

  static fromUnknown(
    status: number,
    body: unknown,
    requestId: string,
    idempotencyKey?: string,
  ): MetalError {
    const parsed = ErrorEnvelopeSchema.safeParse(body);
    if (parsed.success) {
      return MetalError.fromEnvelope(status, parsed.data, idempotencyKey);
    }
    return new MetalError({
      status,
      message: "unexpected metal api response",
      code: "internal_error",
      requestId,
      idempotencyKey,
    });
  }
}

export class RuntimeOperationWaitError extends Error {
  readonly operationId: string;
  readonly idempotencyKey: string;

  constructor(input: {
    message: string;
    operationId: string;
    idempotencyKey: string;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "RuntimeOperationWaitError";
    this.operationId = input.operationId;
    this.idempotencyKey = input.idempotencyKey;
  }
}
