import { ErrorEnvelopeSchema, type ErrorEnvelope } from "@openmetal/contracts";

export class MetalError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(input: {
    message: string;
    status: number;
    code: string;
    requestId: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  }) {
    super(input.message);
    this.name = "MetalError";
    this.status = input.status;
    this.code = input.code;
    this.requestId = input.requestId;
    this.retryable = input.retryable ?? false;
    this.details = input.details;
  }

  static fromEnvelope(status: number, envelope: ErrorEnvelope): MetalError {
    return new MetalError({
      status,
      message: envelope.message,
      code: envelope.code,
      requestId: envelope.request_id,
      retryable: envelope.retryable,
      details: envelope.details,
    });
  }

  static fromUnknown(status: number, body: unknown, requestId: string): MetalError {
    const parsed = ErrorEnvelopeSchema.safeParse(body);
    if (parsed.success) {
      return MetalError.fromEnvelope(status, parsed.data);
    }
    return new MetalError({
      status,
      message: "unexpected metal api response",
      code: "internal_error",
      requestId,
    });
  }
}
