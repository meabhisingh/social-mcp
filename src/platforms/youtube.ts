import { open } from "node:fs/promises";
import { readEnv } from "../env.js";
import { asRecord, PlatformError, ValidationError } from "../errors.js";
import { assertOk, send, USER_AGENT, type HttpResponse } from "../http.js";
import type { LocalMedia, NetDeps, PrivacyStatus } from "../types.js";

const DEFAULT_API = "https://www.googleapis.com";
const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_CHUNK = 8 * 1024 * 1024;

export type YouTubeUploadInput = {
  title: string;
  description: string;
  media: LocalMedia;
  privacyStatus: PrivacyStatus;
  categoryId: string;
  tags: string[];
  madeForKids: boolean;
  chunkBytes?: number;
};

type CachedToken = { token: string; expiresAt: number };

let cachedToken: CachedToken | undefined;

export function resetYouTubeTokenCache(): void {
  cachedToken = undefined;
}

export async function publishYouTube(
  input: YouTubeUploadInput,
  net: NetDeps = {},
): Promise<{ platformId: string }> {
  const fetchImpl = net.fetchImpl ?? globalThis.fetch;
  const apiBase = net.youtubeApiBase ?? DEFAULT_API;
  const tokenUrl = net.youtubeTokenUrl ?? DEFAULT_TOKEN_URL;
  assertVideo(input.media);

  const token = await accessToken(fetchImpl, tokenUrl, false);
  const session = await openSession(fetchImpl, apiBase, tokenUrl, token, input);
  const platformId = await uploadChunks(fetchImpl, apiBase, tokenUrl, session, input);
  return { platformId };
}

function assertVideo(media: LocalMedia): void {
  if (!media.mime.startsWith("video/")) {
    throw new ValidationError("YouTube uploads require a local video file.");
  }
}

async function accessToken(fetchImpl: typeof fetch, tokenUrl: string, forceRefresh: boolean): Promise<string> {
  const existing = readEnv("YOUTUBE_ACCESS_TOKEN");
  const clientId = readEnv("YOUTUBE_CLIENT_ID");
  const clientSecret = readEnv("YOUTUBE_CLIENT_SECRET");
  const refreshToken = readEnv("YOUTUBE_REFRESH_TOKEN");
  const canRefresh = Boolean(clientId && clientSecret && refreshToken);

  if (!forceRefresh && existing) return existing;
  if (!forceRefresh && cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token;
  if (!canRefresh || !clientId || !clientSecret || !refreshToken) {
    if (existing && !forceRefresh) return existing;
    throw new ValidationError(
      "YouTube credentials missing. Set YOUTUBE_ACCESS_TOKEN, or YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, and YOUTUBE_REFRESH_TOKEN.",
    );
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const response = await send(
    fetchImpl,
    tokenUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body,
    },
    60_000,
    [clientSecret, refreshToken],
  );
  return storeToken(response, [clientSecret, refreshToken]);
}

function storeToken(response: HttpResponse, secrets: string[]): string {
  assertOk("YouTube token", response, secrets);
  const record = asRecord(response.json);
  const token = record && typeof record.access_token === "string" ? record.access_token : undefined;
  if (!token) throw new PlatformError("YouTube token response did not include an access token.");
  const expiresIn = record && typeof record.expires_in === "number" ? record.expires_in : 3600;
  cachedToken = { token, expiresAt: Date.now() + Math.max(30, expiresIn - 60) * 1000 };
  return token;
}

async function openSession(
  fetchImpl: typeof fetch,
  apiBase: string,
  tokenUrl: string,
  token: string,
  input: YouTubeUploadInput,
  refreshed = false,
): Promise<{ url: string; token: string }> {
  const endpoint = new URL("/upload/youtube/v3/videos", apiBase.endsWith("/") ? apiBase : `${apiBase}/`);
  endpoint.searchParams.set("uploadType", "resumable");
  endpoint.searchParams.set("part", "snippet,status");
  const snippet: { title: string; description: string; categoryId: string; tags?: string[] } = {
    title: input.title,
    description: input.description,
    categoryId: input.categoryId,
  };
  if (input.tags.length > 0) snippet.tags = input.tags;
  const payload = {
    snippet,
    status: {
      privacyStatus: input.privacyStatus,
      selfDeclaredMadeForKids: input.madeForKids,
    },
  };
  const response = await send(
    fetchImpl,
    endpoint.toString(),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(input.media.size),
        "X-Upload-Content-Type": input.media.mime,
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(payload),
    },
    60_000,
    [token],
  );

  if (response.status === 401 && !refreshed && canRefresh()) {
    const next = await accessToken(fetchImpl, tokenUrl, true);
    return openSession(fetchImpl, apiBase, tokenUrl, next, input, true);
  }
  assertOk("YouTube", response, [token]);
  const location = response.headers.get("location");
  if (!location) throw new PlatformError("YouTube resumable session did not return a Location header.");
  const session = assertSessionUrl(location, apiBase);
  return { url: session.toString(), token };
}

function canRefresh(): boolean {
  return Boolean(readEnv("YOUTUBE_CLIENT_ID") && readEnv("YOUTUBE_CLIENT_SECRET") && readEnv("YOUTUBE_REFRESH_TOKEN"));
}

function assertSessionUrl(location: string, apiBase: string): URL {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    throw new PlatformError("YouTube returned an invalid resumable session URL.");
  }
  const base = new URL(apiBase);
  const official = url.protocol === "https:" && (url.hostname === "www.googleapis.com" || url.hostname.endsWith(".googleapis.com"));
  const localTest = url.protocol === base.protocol && url.hostname === base.hostname && (base.hostname === "127.0.0.1" || base.hostname === "localhost");
  if (!official && !localTest) {
    throw new PlatformError("YouTube returned an unexpected upload host.");
  }
  return url;
}

async function uploadChunks(
  fetchImpl: typeof fetch,
  apiBase: string,
  tokenUrl: string,
  session: { url: string; token: string },
  input: YouTubeUploadInput,
): Promise<string> {
  const chunkSize = input.chunkBytes ?? DEFAULT_CHUNK;
  const total = input.media.size;
  let offset = 0;
  const file = await open(input.media.path, "r");
  try {
    while (offset < total) {
      const length = Math.min(chunkSize, total - offset);
      const buffer = Buffer.alloc(length);
      const read = await file.read(buffer, 0, length, offset);
      const chunk = buffer.subarray(0, read.bytesRead);
      if (chunk.length === 0) throw new PlatformError("YouTube upload ended before the file was sent.");
      const start = offset;
      const end = offset + chunk.length - 1;
      const uploaded = await putChunk(fetchImpl, apiBase, tokenUrl, session, input, chunk, start, end, total);
      if (uploaded.done) return uploaded.platformId;
      if (uploaded.nextOffset <= offset) {
        throw new PlatformError("YouTube resumable offset did not advance.");
      }
      offset = uploaded.nextOffset;
    }
  } finally {
    await file.close();
  }
  throw new PlatformError("YouTube upload finished without a video id.");
}

async function putChunk(
  fetchImpl: typeof fetch,
  apiBase: string,
  tokenUrl: string,
  session: { url: string; token: string },
  input: YouTubeUploadInput,
  chunk: Buffer,
  start: number,
  end: number,
  total: number,
): Promise<{ done: true; platformId: string } | { done: false; nextOffset: number }> {
  let token = session.token;
  let refreshed = false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await send(
      fetchImpl,
      session.url,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": input.media.mime,
          "Content-Length": String(chunk.length),
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "User-Agent": USER_AGENT,
        },
        body: new Blob([Uint8Array.from(chunk)]),
      },
      5 * 60_000,
      [token],
    );

    if (response.status === 401 && !refreshed && canRefresh()) {
      token = await accessToken(fetchImpl, tokenUrl, true);
      session.token = token;
      refreshed = true;
      continue;
    }
    if (response.status === 200 || response.status === 201) {
      return { done: true, platformId: videoId(response.json) };
    }
    if (response.status === 308) {
      const range = response.headers.get("range");
      const received = rangeEnd(range);
      if (received === undefined) {
        throw new PlatformError("YouTube resumable status did not include a Range header.");
      }
      return { done: false, nextOffset: received + 1 };
    }
    if (response.status >= 500 && attempt < 3) {
      await delay(250 * (attempt + 1));
      continue;
    }
    assertOk("YouTube", response, [token]);
  }
  throw new PlatformError("YouTube upload failed after retries.");
}

function videoId(json: unknown): string {
  const record = asRecord(json);
  const id = record?.id;
  if (typeof id === "string" && id.length > 0) return id;
  throw new PlatformError("YouTube upload finished without a video id.");
}

function rangeEnd(range: string | null): number | undefined {
  if (!range) return undefined;
  const match = /bytes=(\d+)-(\d+)/i.exec(range);
  if (!match?.[2]) return undefined;
  const end = Number(match[2]);
  return Number.isInteger(end) ? end : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
