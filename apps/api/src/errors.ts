import type { FastifyReply, FastifyRequest } from "fastify";
import type { ErrorEnvelope } from "@openmetal/contracts";

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
    retryable = statusCode >= 500 || statusCode === 429,
  ) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }
}

export function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: ApiError,
): FastifyReply {
  const body: ErrorEnvelope = {
    code: error.code,
    message: error.message,
    request_id: request.id,
    retryable: error.retryable,
    ...(error.details ? { details: error.details } : {}),
  };
  return reply.status(error.statusCode).send(body);
}
