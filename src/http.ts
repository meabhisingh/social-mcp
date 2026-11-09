import { PlatformError, redact, summarizeBody } from "./errors.js";
import type { FetchLike } from "./types.js";

export const USER_AGENT = "social-mcp/1.0.0";

export type HttpResponse = {
  status: number;
  text: string;
  json: unknown;
  headers: Headers;
};

type RequestInitWithDuplex = RequestInit & { duplex?: "half" };

export async function send(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInitWithDuplex,
  timeoutMs: number,
  secrets: readonly string[],
): Promise<HttpResponse> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new PlatformError(`Request timed out after ${timeoutMs}ms.`);
    }
    throw new PlatformError(redact(error instanceof Error ? error.message : String(error), secrets));
  }

  const text = await response.text();
  let json: unknown;
  if (text) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = undefined;
    }
  }
  return { status: response.status, text, json, headers: response.headers };
}

export function assertOk(
  platform: string,
  response: HttpResponse,
  secrets: readonly string[],
  expected?: readonly number[],
): void {
  const success = expected
    ? expected.includes(response.status)
    : response.status >= 200 && response.status < 300;
  if (success) return;
  throw new PlatformError(
    redact(`${platform} request failed (${response.status}): ${summarizeBody(response.text)}`, secrets),
    response.status,
  );
}
