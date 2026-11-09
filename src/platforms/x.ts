import { open } from "node:fs/promises";
import { readEnv } from "../env.js";
import { asRecord, PlatformError, ValidationError } from "../errors.js";
import { assertOk, send, USER_AGENT } from "../http.js";
import { oauth1AuthorizationHeader } from "../oauth1.js";
import type { LocalMedia, NetDeps } from "../types.js";

const DEFAULT_API = "https://api.x.com";
const CHUNK_BYTES = 4 * 1024 * 1024;
const IMAGE_BYTES = 5 * 1024 * 1024;
const GIF_BYTES = 15 * 1024 * 1024;
const VIDEO_BYTES = 512 * 1024 * 1024;

export type XPublishInput = {
  text: string;
  media: LocalMedia | undefined;
};

type XAuth =
  | { kind: "bearer"; token: string }
  | { kind: "oauth1"; consumerKey: string; consumerSecret: string; token: string; tokenSecret: string };

export async function publishX(input: XPublishInput, net: NetDeps = {}): Promise<{ platformId: string; mediaId?: string }> {
  const fetchImpl = net.fetchImpl ?? globalThis.fetch;
  const apiBase = (net.xApiBase ?? DEFAULT_API).replace(/\/$/, "");
  const text = input.text;
  if (!text.trim() && !input.media) {
    throw new ValidationError("X posts need text, media, or both.");
  }
  if (text.length > 25_000) throw new ValidationError("X text must be at most 25000 characters.");
  const auth = requireAuth();
  const secrets = authSecrets(auth);

  let mediaId: string | undefined;
  if (input.media) {
    assertXMedia(input.media);
    mediaId = await uploadMedia(fetchImpl, apiBase, auth, input.media, secrets);
  }

  const payload: { text: string; media?: { media_ids: string[] } } = { text };
  if (mediaId) payload.media = { media_ids: [mediaId] };
  const tweetUrl = `${apiBase}/2/tweets`;
  const response = await send(
    fetchImpl,
    tweetUrl,
    {
      method: "POST",
      headers: {
        ...(await authHeaders("POST", tweetUrl, auth)),
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(payload),
    },
    60_000,
    secrets,
  );
  assertOk("X", response, secrets);
  const platformId = readDataId(response.json, "X post");
  return mediaId ? { platformId, mediaId } : { platformId };
}

function assertXMedia(media: LocalMedia): void {
  if (media.mime === "image/gif" && media.size > GIF_BYTES) {
    throw new ValidationError("X GIFs must be 15 MB or smaller.");
  }
  if (media.mime.startsWith("image/") && media.mime !== "image/gif" && media.size > IMAGE_BYTES) {
    throw new ValidationError("X images must be 5 MB or smaller.");
  }
  if (media.mime.startsWith("video/") && media.size > VIDEO_BYTES) {
    throw new ValidationError("X videos must be 512 MB or smaller.");
  }
  if (!media.mime.startsWith("image/") && !media.mime.startsWith("video/")) {
    throw new ValidationError("X media must be an image or a video.");
  }
}

function mediaCategory(mime: string): string {
  if (mime === "image/gif") return "tweet_gif";
  if (mime.startsWith("image/")) return "tweet_image";
  return "tweet_video";
}

async function uploadMedia(
  fetchImpl: typeof fetch,
  apiBase: string,
  auth: XAuth,
  media: LocalMedia,
  secrets: string[],
): Promise<string> {
  const initUrl = new URL(`${apiBase}/2/media/upload`);
  initUrl.searchParams.set("command", "INIT");
  initUrl.searchParams.set("media_type", media.mime);
  initUrl.searchParams.set("total_bytes", String(media.size));
  initUrl.searchParams.set("media_category", mediaCategory(media.mime));
  const initHref = initUrl.toString();
  const initResponse = await send(
    fetchImpl,
    initHref,
    {
      method: "POST",
      headers: {
        ...(await authHeaders("POST", initHref, auth)),
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
    },
    60_000,
    secrets,
  );
  assertOk("X media", initResponse, secrets);
  const mediaId = readDataId(initResponse.json, "X media upload");

  const file = await open(media.path, "r");
  try {
    let offset = 0;
    let segment = 0;
    while (offset < media.size) {
      const length = Math.min(CHUNK_BYTES, media.size - offset);
      const buffer = Buffer.alloc(length);
      const read = await file.read(buffer, 0, length, offset);
      const chunk = buffer.subarray(0, read.bytesRead);
      if (chunk.length === 0) throw new PlatformError("X media upload ended before the file was sent.");
      const appendUrl = `${apiBase}/2/media/upload`;
      const form = new FormData();
      form.append("command", "APPEND");
      form.append("media_id", mediaId);
      form.append("segment_index", String(segment));
      form.append("media", new Blob([chunk], { type: "application/octet-stream" }), "media");
      const appendResponse = await send(
        fetchImpl,
        appendUrl,
        {
          method: "POST",
          headers: {
            ...(await authHeaders("POST", appendUrl, auth)),
            "User-Agent": USER_AGENT,
          },
          body: form,
        },
        5 * 60_000,
        secrets,
      );
      assertOk("X media", appendResponse, secrets);
      offset += chunk.length;
      segment += 1;
    }
  } finally {
    await file.close();
  }

  const finalizeUrl = new URL(`${apiBase}/2/media/upload`);
  finalizeUrl.searchParams.set("command", "FINALIZE");
  finalizeUrl.searchParams.set("media_id", mediaId);
  const finalizeHref = finalizeUrl.toString();
  const finalizeResponse = await send(
    fetchImpl,
    finalizeHref,
    {
      method: "POST",
      headers: {
        ...(await authHeaders("POST", finalizeHref, auth)),
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
    },
    60_000,
    secrets,
  );
  assertOk("X media", finalizeResponse, secrets);
  await waitUntilProcessed(fetchImpl, apiBase, auth, mediaId, finalizeResponse.json, secrets);
  return mediaId;
}

async function waitUntilProcessed(
  fetchImpl: typeof fetch,
  apiBase: string,
  auth: XAuth,
  mediaId: string,
  finalizeJson: unknown,
  secrets: string[],
): Promise<void> {
  let info = processingInfo(finalizeJson);
  for (let attempt = 0; attempt < 30 && info; attempt += 1) {
    const state = typeof info.state === "string" ? info.state : "";
    if (state === "succeeded") return;
    if (state === "failed") {
      const error = asRecord(info.error);
      const message = error && typeof error.message === "string" ? error.message : "X media processing failed.";
      throw new PlatformError(message);
    }
    const waitSeconds = typeof info.check_after_secs === "number" ? info.check_after_secs : 0;
    const waitMs = Math.min(Math.max(waitSeconds, 0), 15) * 1000;
    if (waitMs > 0) await delay(waitMs);
    const statusUrl = new URL(`${apiBase}/2/media/upload`);
    statusUrl.searchParams.set("command", "STATUS");
    statusUrl.searchParams.set("media_id", mediaId);
    const href = statusUrl.toString();
    const response = await send(
      fetchImpl,
      href,
      {
        method: "GET",
        headers: {
          ...(await authHeaders("GET", href, auth)),
          "User-Agent": USER_AGENT,
        },
      },
      60_000,
      secrets,
    );
    assertOk("X media", response, secrets);
    info = processingInfo(response.json);
  }
  if (info) throw new PlatformError("X media processing did not finish in time.");
}

function processingInfo(json: unknown): Record<string, unknown> | undefined {
  const record = asRecord(json);
  const data = asRecord(record?.data) ?? record;
  return asRecord(data?.processing_info);
}

function readDataId(json: unknown, label: string): string {
  const record = asRecord(json);
  const data = asRecord(record?.data) ?? record;
  const id = data?.id ?? data?.media_id_string ?? data?.media_id;
  if (typeof id === "string" && id.length > 0) return id;
  if (typeof id === "number") return String(id);
  throw new PlatformError(`${label} response did not include an id.`);
}

function requireAuth(): XAuth {
  const bearer = readEnv("X_OAUTH2_ACCESS_TOKEN");
  if (bearer) return { kind: "bearer", token: bearer };
  const consumerKey = readEnv("X_API_KEY");
  const consumerSecret = readEnv("X_API_SECRET");
  const token = readEnv("X_ACCESS_TOKEN");
  const tokenSecret = readEnv("X_ACCESS_TOKEN_SECRET");
  if (consumerKey && consumerSecret && token && tokenSecret) {
    return { kind: "oauth1", consumerKey, consumerSecret, token, tokenSecret };
  }
  throw new ValidationError(
    "X credentials missing. Set X_OAUTH2_ACCESS_TOKEN (user-context OAuth 2.0 with tweet.write and media.write), or X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, and X_ACCESS_TOKEN_SECRET.",
  );
}

function authSecrets(auth: XAuth): string[] {
  if (auth.kind === "bearer") return [auth.token];
  return [auth.consumerSecret, auth.tokenSecret, auth.token];
}

async function authHeaders(method: string, url: string, auth: XAuth): Promise<Record<string, string>> {
  if (auth.kind === "bearer") return { Authorization: `Bearer ${auth.token}` };
  return {
    Authorization: oauth1AuthorizationHeader(method, url, {
      consumerKey: auth.consumerKey,
      consumerSecret: auth.consumerSecret,
      token: auth.token,
      tokenSecret: auth.tokenSecret,
    }),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
