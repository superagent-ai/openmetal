import pino, { type Logger, type LoggerOptions } from "pino";
import { redactRecord, REDACTED } from "./redact.js";

export type MetalLoggerFields = {
  request_id?: string;
  service?: string;
  environment?: string;
  organization_id?: string;
  project_id?: string;
  job_id?: string;
  event_id?: string;
  method?: string;
  path?: string;
  status_code?: number;
  duration_ms?: number;
};

export type CreateLoggerOptions = {
  service: string;
  environment?: string;
  level?: string;
  destination?: pino.DestinationStream;
};

function wrapLogMethod(logger: Logger, method: "info" | "error" | "warn" | "debug" | "fatal") {
  const original = logger[method].bind(logger);
  return (obj: unknown, msg?: string, ...args: unknown[]) => {
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      original(redactRecord(obj as Record<string, unknown>), msg, ...args);
      return;
    }
    if (typeof obj === "string") {
      original(redactRecord({ msg: obj }), msg, ...args);
      return;
    }
    original(obj as object, msg, ...args);
  };
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const pinoOptions: LoggerOptions = {
    level: options.level ?? "info",
    base: {
      service: options.service,
      environment: options.environment ?? "development",
    },
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers['set-cookie']",
        "headers.authorization",
        "headers.cookie",
        "access_token",
        "refresh_token",
        "password",
        "DATABASE_URL",
        "SUPABASE_SECRET_KEY",
      ],
      censor: REDACTED,
    },
  };

  const logger = options.destination ? pino(pinoOptions, options.destination) : pino(pinoOptions);

  logger.info = wrapLogMethod(logger, "info") as Logger["info"];
  logger.error = wrapLogMethod(logger, "error") as Logger["error"];
  logger.warn = wrapLogMethod(logger, "warn") as Logger["warn"];
  logger.debug = wrapLogMethod(logger, "debug") as Logger["debug"];
  logger.fatal = wrapLogMethod(logger, "fatal") as Logger["fatal"];

  return logger;
}

export function childLogger(logger: Logger, fields: MetalLoggerFields): Logger {
  return logger.child(redactRecord(fields));
}
