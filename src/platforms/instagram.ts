import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { readEnv } from "../env.js";
import { asRecord, PlatformError, ValidationError } from "../errors.js";
import { assertOk, send, USER_AGENT } from "../http.js";
import type { InstagramKind, MediaRef, NetDeps } from "../types.js";

const DEFAULT_VERSION = "v22.0";
const DEFAULT_HOST = "graph.facebook.com";
const DEFAULT_TIMEOUT_MS = 180_000;

/** Graph API media-container limit for the collaborators field. */
export const INSTAGRAM_COLLABORATOR_LIMIT = 3;

const COLLABORATOR_USERNAME = /^(?!.*\.\.)(?!\.)(?!.*\.$)[A-Za-z0-9._]{1,30}$/;

export type InstagramPublishInput = {
  caption: string;
  media: MediaRef;
  mediaType: InstagramKind | undefined;
  shareToFeed: boolean | undefined;
  altText: string | undefined;
  collaborators?: readonly string[];
};

/**
 * Normalize collaborator usernames for the media container.
 * Strips a leading @, drops case-insensitive duplicates, and rejects more than the API allows.
 */
export function normalizeCollaborators(values: readonly string[] | undefined): string[] {
  if (!values || values.length === 0) return [];
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const trimmed = raw.trim().replace(/^@+/, "");
    if (!COLLABORATOR_USERNAME.test(trimmed)) {
      throw new ValidationError(
        `Instagram collaborator "${raw.trim()}" is not a username. Use 1-30 letters, numbers, periods, or underscores, and do not start, end, or repeat a period.`,
      );
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }
  if (normalized.length > INSTAGRAM_COLLABORATOR_LIMIT) {
    throw new ValidationError(
      `Instagram allows at most ${INSTAGRAM_COLLABORATOR_LIMIT} collaborators on a media container.`,
    );
  }
  return normalized;
}

export async function publishInstagram(
  input: InstagramPublishInput,
  net: NetDeps = {},
): Promise<{ platformId: string; containerId: string; invitesSent: string[] }> {
  const fetchImpl = net.fetchImpl ?? globalThis.fetch;
  const token = requireToken();
  const userId = requireUserId();
  const version = graphVersion();
  const graphBase = net.instagramGraphBase ?? `https://${graphHost()}/${version}`;
  const uploadBase = net.instagramUploadBase ?? "https://rupload.facebook.com";
  const kind = resolveKind(input.media, input.mediaType);
  const collaborators = normalizeCollaborators(input.collaborators);
  const secrets = [token];
  if (kind === "story" && collaborators.length > 0) {
    throw new ValidationError("Instagram Stories do not support collaborator invites. Use a feed image or Reel.");
  }

  if (kind === "image" && input.media.kind !== "url") {
    throw new ValidationError(
      "Instagram photo publishing requires a public https image_url. Pass that URL as mediaPath. Local files are uploaded for Reels with the resumable container flow.",
    );
  }
  if (input.media.kind === "file" && !input.media.mime.startsWith("video/")) {
    throw new ValidationError("Local Instagram uploads must be a video file. Photos need a public https URL.");
  }
  if (input.media.kind === "url" && input.media.mime?.startsWith("image/") && kind !== "image" && kind !== "story") {
    throw new ValidationError("This URL looks like an image. Set mediaType to image or story.");
  }
  if (input.media.kind === "file" && graphHost() === "graph.instagram.com" && !net.instagramGraphBase) {
    throw new ValidationError(
      "Local Reel upload uses rupload.facebook.com and Facebook Login (graph.facebook.com). With Instagram Login, pass a public https video_url.",
    );
  }

  const container = await createContainer(fetchImpl, graphBase, userId, token, input, kind, collaborators, secrets);
  if (input.media.kind === "file") {
    await uploadLocalVideo(fetchImpl, uploadBase, version, container.id, container.uri, input.media.path, input.media.size, token, secrets);
  }
  await waitUntilFinished(fetchImpl, graphBase, container.id, token, secrets);
  const platformId = await publishContainer(fetchImpl, graphBase, userId, container.id, token, secrets);
  return { platformId, containerId: container.id, invitesSent: collaborators };
}

function requireToken(): string {
  const token = readEnv("INSTAGRAM_ACCESS_TOKEN");
  if (!token) throw new ValidationError("Instagram credentials missing. Set INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_USER_ID.");
  return token;
}

function requireUserId(): string {
  const userId = readEnv("INSTAGRAM_USER_ID");
  if (!userId) throw new ValidationError("Instagram credentials missing. Set INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_USER_ID.");
  if (!/^[A-Za-z0-9_.:-]+$/.test(userId)) {
    throw new ValidationError("INSTAGRAM_USER_ID contains unsupported characters.");
  }
  return userId;
}

function graphVersion(): string {
  const version = readEnv("INSTAGRAM_GRAPH_VERSION") ?? DEFAULT_VERSION;
  if (!/^v\d+\.\d+$/.test(version)) {
    throw new ValidationError("INSTAGRAM_GRAPH_VERSION must look like v22.0.");
  }
  return version;
}

function graphHost(): string {
  const host = readEnv("INSTAGRAM_GRAPH_HOST") ?? DEFAULT_HOST;
  if (host !== "graph.facebook.com" && host !== "graph.instagram.com") {
    throw new ValidationError("INSTAGRAM_GRAPH_HOST must be graph.facebook.com or graph.instagram.com.");
  }
  return host;
}

function resolveKind(media: MediaRef, override: InstagramKind | undefined): InstagramKind {
  if (override === "story") return "story";
  if (override === "image") {
    if (media.kind === "file" && media.mime.startsWith("video/")) {
      throw new ValidationError("mediaType image does not accept a video file.");
    }
    return "image";
  }
  if (override === "reel") {
    if (media.kind === "file" && media.mime.startsWith("image/")) {
      throw new ValidationError("mediaType reel requires a video file or a video URL.");
    }
    if (media.kind === "url" && media.mime?.startsWith("image/")) {
      throw new ValidationError("mediaType reel requires a video URL.");
    }
    return "reel";
  }
  if (media.mime?.startsWith("video/") || (media.kind === "file" && media.mime.startsWith("video/"))) return "reel";
  if (media.mime?.startsWith("image/")) return "image";
  if (media.kind === "url") {
    throw new ValidationError("Set mediaType to image, reel, or story when the URL has no known extension.");
  }
  return media.mime.startsWith("video/") ? "reel" : "image";
}

async function createContainer(
  fetchImpl: typeof fetch,
  graphBase: string,
  userId: string,
  token: string,
  input: InstagramPublishInput,
  kind: InstagramKind,
  collaborators: readonly string[],
  secrets: string[],
): Promise<{ id: string; uri: string | undefined }> {
  const params = new URLSearchParams();
  params.set("access_token", token);
  if (input.caption.trim()) params.set("caption", input.caption);
  if (collaborators.length > 0) params.set("collaborators", JSON.stringify([...collaborators]));
  const remoteImage = input.media.kind === "url" && (kind === "image" || (kind === "story" && input.media.mime?.startsWith("image/")));
  if (remoteImage) {
    if (input.media.kind !== "url") throw new ValidationError("Instagram image containers require an https image_url.");
    if (kind === "story") params.set("media_type", "STORIES");
    params.set("image_url", input.media.url);
    if (kind === "image" && input.altText) params.set("alt_text", input.altText);
  } else if (input.media.kind === "url") {
    if (kind === "story" && !input.media.mime) {
      throw new ValidationError("Story URLs need an image or video file extension.");
    }
    params.set("media_type", kind === "story" ? "STORIES" : "REELS");
    params.set("video_url", input.media.url);
    if (kind === "reel") params.set("share_to_feed", input.shareToFeed === false ? "false" : "true");
  } else {
    params.set("media_type", kind === "story" ? "STORIES" : "REELS");
    params.set("upload_type", "resumable");
    if (kind === "reel") params.set("share_to_feed", input.shareToFeed === false ? "false" : "true");
  }

  const response = await send(
    fetchImpl,
    `${trimSlash(graphBase)}/${userId}/media`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: params,
    },
    60_000,
    secrets,
  );
  assertOk("Instagram", response, secrets);
  const record = asRecord(response.json);
  const id = record && typeof record.id === "string" ? record.id : undefined;
  if (!id) throw new PlatformError("Instagram did not return a media container id.");
  const uri = record && typeof record.uri === "string" ? record.uri : undefined;
  return { id, uri };
}

async function uploadLocalVideo(
  fetchImpl: typeof fetch,
  uploadBase: string,
  version: string,
  containerId: string,
  uri: string | undefined,
  filePath: string,
  size: number,
  token: string,
  secrets: string[],
): Promise<void> {
  const constructed = `${trimSlash(uploadBase)}/ig-api-upload/${version}/${containerId}`;
  const uploadUrl = chooseUploadUrl(uri, constructed, uploadBase);
  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
  const response = await send(
    fetchImpl,
    uploadUrl,
    {
      method: "POST",
      headers: {
        Authorization: `OAuth ${token}`,
        offset: "0",
        file_size: String(size),
        "Content-Length": String(size),
        "User-Agent": USER_AGENT,
      },
      body: stream,
      duplex: "half",
    },
    15 * 60_000,
    secrets,
  );
  assertOk("Instagram upload", response, secrets);
  const record = asRecord(response.json);
  if (record && record.success === false) {
    const message = typeof record.message === "string" ? record.message : "Instagram upload was rejected.";
    throw new PlatformError(message);
  }
}

function chooseUploadUrl(uri: string | undefined, constructed: string, uploadBase: string): string {
  if (!uri) return constructed;
  let candidate: URL;
  try {
    candidate = new URL(uri);
  } catch {
    return constructed;
  }
  const base = new URL(uploadBase);
  const official = candidate.protocol === "https:" && candidate.hostname === "rupload.facebook.com";
  const local = candidate.hostname === base.hostname && candidate.protocol === base.protocol;
  if (official || local) return candidate.toString();
  return constructed;
}

async function waitUntilFinished(
  fetchImpl: typeof fetch,
  graphBase: string,
  containerId: string,
  token: string,
  secrets: string[],
): Promise<void> {
  const timeout = statusTimeout();
  const deadline = Date.now() + timeout;
  for (;;) {
    const url = new URL(`${trimSlash(graphBase)}/${containerId}`);
    url.searchParams.set("fields", "status_code,status");
    url.searchParams.set("access_token", token);
    const response = await send(fetchImpl, url.toString(), { method: "GET", headers: { "User-Agent": USER_AGENT } }, 60_000, secrets);
    assertOk("Instagram", response, secrets);
    const record = asRecord(response.json);
    const code = record && typeof record.status_code === "string" ? record.status_code : undefined;
    if (code === "FINISHED" || code === "PUBLISHED") return;
    if (code === "ERROR" || code === "EXPIRED") {
      const detail = record && typeof record.status === "string" ? record.status : code;
      throw new PlatformError(`Instagram container ${code}: ${detail}`);
    }
    if (Date.now() >= deadline) {
      throw new PlatformError(`Instagram container was not ready to publish within ${timeout}ms (status ${code ?? "unknown"}).`);
    }
    await delay(2_000);
  }
}

async function publishContainer(
  fetchImpl: typeof fetch,
  graphBase: string,
  userId: string,
  containerId: string,
  token: string,
  secrets: string[],
): Promise<string> {
  const params = new URLSearchParams({ access_token: token, creation_id: containerId });
  const response = await send(
    fetchImpl,
    `${trimSlash(graphBase)}/${userId}/media_publish`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: params,
    },
    60_000,
    secrets,
  );
  assertOk("Instagram", response, secrets);
  const record = asRecord(response.json);
  const id = record && typeof record.id === "string" ? record.id : undefined;
  if (!id) throw new PlatformError("Instagram publish response did not include a media id.");
  return id;
}

function statusTimeout(): number {
  const raw = readEnv("INSTAGRAM_STATUS_TIMEOUT_MS");
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1000) {
    throw new ValidationError("INSTAGRAM_STATUS_TIMEOUT_MS must be a number of milliseconds >= 1000.");
  }
  return parsed;
}

function trimSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
