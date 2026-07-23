const SENSITIVE_KEY =
  /password|passphrase|secret|token|authorization|cookie|body|subject|source|credential/i;

export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item));
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactSensitive(item);
    }
    return output;
  }

  return value;
}

export const safeLogger = {
  info(message: string): void {
    console.info(message);
  },
  error(message: string): void {
    console.error(message);
  },
};
