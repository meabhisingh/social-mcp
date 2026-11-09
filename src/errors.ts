export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class PlatformError extends Error {
  readonly status: number | undefined;
  readonly localId: string | undefined;

  constructor(message: string, status?: number, localId?: string) {
    super(message);
    this.name = "PlatformError";
    this.status = status;
    this.localId = localId;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

export function redact(text: string, secrets: readonly string[] = []): string {
  let output = text
    .replace(/access_token=[^&\s"]+/gi, "access_token=[redacted]")
    .replace(/refresh_token=[^&\s"]+/gi, "refresh_token=[redacted]")
    .replace(/client_secret=[^&\s"]+/gi, "client_secret=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, "Bearer [redacted]")
    .replace(/OAuth\s+[^\s"]+/g, "OAuth [redacted]");
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    output = output.split(secret).join("[redacted]");
  }
  return output;
}

export function summarizeBody(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "empty response";
  try {
    const message = extractMessage(JSON.parse(trimmed) as unknown);
    if (message) return message.slice(0, 1500);
  } catch {
    // Fall through to the raw body.
  }
  return trimmed.slice(0, 1500);
}

function extractMessage(json: unknown): string | undefined {
  const record = asRecord(json);
  if (!record) return undefined;
  const error = asRecord(record.error);
  if (error && typeof error.message === "string") return error.message;
  if (Array.isArray(record.errors)) {
    const first = asRecord(record.errors[0]);
    if (first && typeof first.message === "string") return first.message;
    if (typeof record.errors[0] === "string") return record.errors[0];
  }
  if (typeof record.detail === "string") return record.detail;
  if (typeof record.title === "string" && typeof record.detail !== "string") return record.title;
  if (typeof record.message === "string") return record.message;
  return undefined;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function localIdFrom(error: unknown): string | undefined {
  if (error instanceof PlatformError && error.localId) return error.localId;
  return undefined;
}
