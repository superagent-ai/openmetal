export const REDACTED = "[REDACTED]";

const SECRET_KEY_PATTERN =
  /(authorization|cookie|set-cookie|token|secret|password|passwd|api[_-]?key|apikey|access[_-]?key|refresh[_-]?token|service[_-]?role|database[_-]?url|connectionstring|signed[_-]?url|credential)/i;

const SECRET_VALUE_PATTERN =
  /(Bearer\s+[^\s"']+|sb_secret_[A-Za-z0-9_]+|sb_publishable_[A-Za-z0-9_]+|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|postgres(?:ql)?:\/\/[^\s"']+|service_role|sk_live_[A-Za-z0-9]+|sk_test_[A-Za-z0-9]+|rk_(?:live|test)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+|sk-[A-Za-z0-9]{20,}|(?:https?:\/\/|\/)[^\s"']+\?(?:[^\s"']*(?:token|sig|signature|X-Amz-Signature)=[^\s"']+))/i;

const SECRET_ENV_NAMES = new Set([
  "DATABASE_URL",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ACCESS_TOKEN",
  "SUPABASE_JWT_SECRET",
  "POSTGRES_PASSWORD",
  "API_KEY",
  "PROVIDER_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
]);

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key) || SECRET_ENV_NAMES.has(key);
}

export function redactString(value: string): string {
  if (SECRET_VALUE_PATTERN.test(value)) {
    return REDACTED;
  }
  return value;
}

export function redactValue(key: string | undefined, value: unknown, depth = 0): unknown {
  if (depth > 8) {
    return REDACTED;
  }
  if (key && isSecretKey(key)) {
    return REDACTED;
  }
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(key, item, depth + 1));
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      output[childKey] = redactValue(childKey, childValue, depth + 1);
    }
    return output;
  }
  return value;
}

export function redactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return redactValue(undefined, input) as Record<string, unknown>;
}
