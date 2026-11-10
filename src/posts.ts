import { randomUUID } from "node:crypto";
import { errorMessage, PlatformError, ValidationError } from "./errors.js";
import { isImageMime, isVideoMime, resolveMedia, retainLocalMedia } from "./media.js";
import { normalizeCollaborators, publishInstagram } from "./platforms/instagram.js";
import { publishX } from "./platforms/x.js";
import { publishYouTube } from "./platforms/youtube.js";
import { getStoredPost, modifyPosts, readAllPosts, requirePost } from "./store.js";
import type {
  InstagramKind,
  MediaRef,
  NetDeps,
  Platform,
  PostRecord,
  PrivacyStatus,
  PublishResult,
} from "./types.js";

const YOUTUBE_TITLE = 100;
const YOUTUBE_DESCRIPTION = 5000;
const INSTAGRAM_CAPTION = 2200;
const X_TEXT = 25_000;
const TAG_TOTAL = 500;

export type YouTubePostInput = {
  title: string;
  content: string;
  mediaPath: string;
  privacyStatus?: PrivacyStatus;
  categoryId?: string;
  tags?: string[];
  madeForKids?: boolean;
};

export type InstagramPostInput = {
  content: string;
  mediaPath: string;
  mediaType?: InstagramKind;
  shareToFeed?: boolean;
  altText?: string;
  collaborators?: string[];
};

export type XPostInput = {
  content: string;
  mediaPath?: string;
};

export type ScheduleInput = {
  platform: Platform;
  content: string;
  mediaPath: string;
  runAt: string;
  title?: string;
  privacyStatus?: PrivacyStatus;
  categoryId?: string;
  tags?: string[];
  madeForKids?: boolean;
  mediaType?: InstagramKind;
  shareToFeed?: boolean;
  altText?: string;
  collaborators?: string[];
};

export async function postYouTube(input: YouTubePostInput, net?: NetDeps): Promise<PublishResult> {
  assertLength(input.content, YOUTUBE_DESCRIPTION, "YouTube description");
  const title = requireTitle(input.title);
  const tags = normalizeTags(input.tags);
  const media = await requireLocalVideo(input.mediaPath);
  const record = await createRecord({
    platform: "youtube",
    content: input.content,
    media,
    runAt: null,
    status: "publishing",
    title,
    privacyStatus: input.privacyStatus ?? "private",
    categoryId: input.categoryId ?? "22",
    tags,
    madeForKids: input.madeForKids ?? false,
  });
  return publishRecord(record, net);
}

export async function postInstagram(input: InstagramPostInput, net?: NetDeps): Promise<PublishResult> {
  assertLength(input.content, INSTAGRAM_CAPTION, "Instagram caption");
  if (input.altText && input.altText.length > 1000) {
    throw new ValidationError("Instagram alt text must be at most 1000 characters.");
  }
  const collaborators = normalizeCollaborators(input.collaborators);
  assertCollaboratorsAllowed(input.mediaType, collaborators);
  const media = await resolveMedia(input.mediaPath);
  assertInstagramMedia(media, input.mediaType);
  const record = await createRecord({
    platform: "instagram",
    content: input.content,
    media,
    runAt: null,
    status: "publishing",
    mediaType: input.mediaType,
    shareToFeed: input.shareToFeed,
    altText: input.altText,
    collaborators,
  });
  return publishRecord(record, net);
}

export async function postX(input: XPostInput, net?: NetDeps): Promise<PublishResult> {
  assertLength(input.content, X_TEXT, "X text");
  const mediaPath = input.mediaPath?.trim();
  if (!input.content.trim() && !mediaPath) {
    throw new ValidationError("X posts need text, media, or both.");
  }
  const media = mediaPath ? await requireXFile(mediaPath) : undefined;
  const record = await createRecord({
    platform: "x",
    content: input.content,
    media,
    mediaPath: media ? undefined : "",
    runAt: null,
    status: "publishing",
  });
  return publishRecord(record, net);
}

export async function schedulePost(input: ScheduleInput): Promise<PostRecord> {
  const runAt = normalizeRunAt(input.runAt);
  if (input.platform === "youtube" && input.categoryId && !/^\d{1,4}$/.test(input.categoryId)) {
    throw new ValidationError("YouTube categoryId must be numeric.");
  }
  assertScheduleContent(input);
  const collaborators = input.platform === "instagram" ? normalizeCollaborators(input.collaborators) : [];
  if (input.platform !== "instagram" && input.collaborators && input.collaborators.length > 0) {
    throw new ValidationError("Collaborator invites are only supported for Instagram.");
  }
  assertCollaboratorsAllowed(input.mediaType, collaborators);
  const media = await resolveMedia(input.mediaPath);
  if (input.platform === "youtube") {
    if (media.kind !== "file" || !isVideoMime(media.mime)) {
      throw new ValidationError("YouTube posts need a local video file.");
    }
  } else if (input.platform === "instagram") {
    assertInstagramMedia(media, input.mediaType);
  } else if (media.kind !== "file") {
    throw new ValidationError("X posts need a local media file.");
  }
  return createRecord({
    platform: input.platform,
    content: input.content,
    media,
    runAt,
    status: "scheduled",
    title: input.platform === "youtube" ? requireTitle(input.title ?? "") : undefined,
    privacyStatus: input.platform === "youtube" ? input.privacyStatus ?? "private" : undefined,
    categoryId: input.platform === "youtube" ? input.categoryId ?? "22" : undefined,
    tags: input.platform === "youtube" ? normalizeTags(input.tags) : undefined,
    madeForKids: input.platform === "youtube" ? input.madeForKids ?? false : undefined,
    mediaType: input.platform === "instagram" ? input.mediaType : undefined,
    shareToFeed: input.platform === "instagram" ? input.shareToFeed : undefined,
    altText: input.platform === "instagram" ? input.altText : undefined,
    collaborators: input.platform === "instagram" ? collaborators : undefined,
  });
}

export async function listScheduled(limit = 20): Promise<{ posts: PostRecord[] }> {
  const posts = await readAllPosts();
  const scheduled = posts
    .filter((post) => post.status === "scheduled")
    .sort((left, right) => (left.runAt ?? "").localeCompare(right.runAt ?? ""));
  return { posts: scheduled.slice(0, clampLimit(limit, 100)) };
}

export async function getPost(id: string): Promise<PostRecord> {
  return getStoredPost(id);
}

export async function cancelScheduled(id: string): Promise<PostRecord> {
  let updated: PostRecord | undefined;
  await modifyPosts((posts) => {
    const { index, post } = requirePost(posts, id);
    if (post.status !== "scheduled") {
      throw new ValidationError(`Only scheduled posts can be cancelled. This post is ${post.status}.`);
    }
    updated = { ...post, status: "cancelled", updatedAt: new Date().toISOString() };
    posts[index] = updated;
  });
  if (!updated) throw new ValidationError(`Only scheduled posts can be cancelled.`);
  return updated;
}

export async function listPublished(limit = 20): Promise<{ posts: PostRecord[] }> {
  const posts = await readAllPosts();
  const published = posts
    .filter((post) => post.status === "published")
    .sort((left, right) => (right.publishedAt ?? "").localeCompare(left.publishedAt ?? ""));
  return { posts: published.slice(0, clampLimit(limit, 100)) };
}

export type DueResult = {
  ran: Array<{
    id: string;
    platform: Platform;
    status: "published" | "failed";
    platformId?: string;
    error?: string;
    invitesSent?: string[];
  }>;
};

export async function runDuePosts(options?: { now?: Date; limit?: number; net?: NetDeps }): Promise<DueResult> {
  const now = (options?.now ?? new Date()).toISOString();
  const limit = clampLimit(options?.limit ?? 10, 50);
  const claimed: PostRecord[] = [];
  await modifyPosts((posts) => {
    const due = posts
      .filter((post) => post.status === "scheduled" && post.runAt !== null && post.runAt <= now)
      .sort((left, right) => (left.runAt ?? "").localeCompare(right.runAt ?? ""));
    for (const post of due.slice(0, limit)) {
      post.status = "publishing";
      post.updatedAt = new Date().toISOString();
      claimed.push({ ...post });
    }
  });

  const ran: DueResult["ran"] = [];
  for (const post of claimed) {
    try {
      const result = await publishRecord(post, options?.net);
      ran.push({
        id: result.id,
        platform: result.platform,
        status: "published",
        platformId: result.platformId,
        ...(result.invitesSent ? { invitesSent: result.invitesSent } : {}),
      });
    } catch (error) {
      const message = errorMessage(error);
      ran.push({ id: post.id, platform: post.platform, status: "failed", error: message });
    }
  }
  return { ran };
}

async function publishRecord(record: PostRecord, net?: NetDeps): Promise<PublishResult> {
  try {
    const published = await dispatch(record, net);
    const publishedAt = new Date().toISOString();
    await modifyPosts((posts) => {
      const { index, post } = requirePost(posts, record.id);
      posts[index] = {
        ...post,
        status: "published",
        platformId: published.platformId,
        publishedAt,
        updatedAt: publishedAt,
        ...(published.containerId ? { containerId: published.containerId } : {}),
        ...(published.mediaId ? { mediaId: published.mediaId } : {}),
        ...(published.invitesSent ? { invitesSent: published.invitesSent } : {}),
        error: undefined,
      };
    });
    return {
      id: record.id,
      platform: record.platform,
      platformId: published.platformId,
      status: "published",
      publishedAt,
      ...(published.containerId ? { containerId: published.containerId } : {}),
      ...(published.mediaId ? { mediaId: published.mediaId } : {}),
      ...(published.invitesSent ? { invitesSent: published.invitesSent } : {}),
    };
  } catch (error) {
    const message = errorMessage(error);
    try {
      await modifyPosts((posts) => {
        const { index, post } = requirePost(posts, record.id);
        posts[index] = { ...post, status: "failed", error: message, updatedAt: new Date().toISOString() };
      });
    } catch {
      // Keep the platform error if the store cannot record the failure.
    }
    const status = error instanceof PlatformError ? error.status : undefined;
    throw new PlatformError(message, status, record.id);
  }
}

async function dispatch(
  record: PostRecord,
  net?: NetDeps,
): Promise<{ platformId: string; containerId?: string; mediaId?: string; invitesSent?: string[] }> {
  if (record.platform === "youtube") {
    const media = await requireLocalVideo(record.mediaPath);
    const result = await publishYouTube(
      {
        title: requireTitle(record.title ?? ""),
        description: record.content,
        media,
        privacyStatus: record.privacyStatus ?? "private",
        categoryId: record.categoryId ?? "22",
        tags: record.tags ?? [],
        madeForKids: record.madeForKids ?? false,
      },
      net,
    );
    return { platformId: result.platformId };
  }
  if (record.platform === "instagram") {
    const media = await resolveMedia(record.mediaPath);
    assertInstagramMedia(media, record.mediaType);
    const result = await publishInstagram(
      {
        caption: record.content,
        media,
        mediaType: record.mediaType,
        shareToFeed: record.shareToFeed,
        altText: record.altText,
        collaborators: record.collaborators,
      },
      net,
    );
    return { platformId: result.platformId, containerId: result.containerId, invitesSent: result.invitesSent };
  }
  const media = record.mediaPath ? await requireXFile(record.mediaPath) : undefined;
  const result = await publishX({ text: record.content, media }, net);
  return { platformId: result.platformId, ...(result.mediaId ? { mediaId: result.mediaId } : {}) };
}

type Draft = {
  platform: Platform;
  content: string;
  media?: MediaRef;
  mediaPath?: string;
  runAt: string | null;
  status: "scheduled" | "publishing";
  title?: string;
  privacyStatus?: PrivacyStatus;
  categoryId?: string;
  tags?: string[];
  madeForKids?: boolean;
  mediaType?: InstagramKind;
  shareToFeed?: boolean;
  altText?: string;
  collaborators?: string[];
};

async function createRecord(draft: Draft): Promise<PostRecord> {
  const id = randomUUID();
  const now = new Date().toISOString();
  let mediaPath = draft.mediaPath ?? "";
  if (draft.media?.kind === "file") {
    mediaPath = await retainLocalMedia(id, draft.media.path);
  } else if (draft.media?.kind === "url") {
    mediaPath = draft.media.url;
  }
  const record: PostRecord = {
    id,
    platform: draft.platform,
    content: draft.content,
    mediaPath,
    runAt: draft.runAt,
    status: draft.status,
    createdAt: now,
    updatedAt: now,
  };
  if (draft.title !== undefined) record.title = draft.title;
  if (draft.privacyStatus !== undefined) record.privacyStatus = draft.privacyStatus;
  if (draft.categoryId !== undefined) record.categoryId = draft.categoryId;
  if (draft.tags !== undefined) record.tags = draft.tags;
  if (draft.madeForKids !== undefined) record.madeForKids = draft.madeForKids;
  if (draft.mediaType !== undefined) record.mediaType = draft.mediaType;
  if (draft.shareToFeed !== undefined) record.shareToFeed = draft.shareToFeed;
  if (draft.altText !== undefined) record.altText = draft.altText;
  if (draft.collaborators && draft.collaborators.length > 0) record.collaborators = draft.collaborators;
  await modifyPosts((posts) => {
    posts.push(record);
  });
  return record;
}

function assertScheduleContent(input: ScheduleInput): void {
  if (input.platform === "youtube") assertLength(input.content, YOUTUBE_DESCRIPTION, "YouTube description");
  if (input.platform === "instagram") assertLength(input.content, INSTAGRAM_CAPTION, "Instagram caption");
  if (input.platform === "x") {
    assertLength(input.content, X_TEXT, "X text");
    if (!input.content.trim() && !input.mediaPath.trim()) {
      throw new ValidationError("X posts need text, media, or both.");
    }
  }
  if (input.altText && input.altText.length > 1000) {
    throw new ValidationError("Instagram alt text must be at most 1000 characters.");
  }
}

async function requireLocalVideo(mediaPath: string) {
  const media = await resolveMedia(mediaPath);
  if (media.kind !== "file" || !isVideoMime(media.mime)) {
    throw new ValidationError("YouTube uploads require a local video file.");
  }
  return media;
}

async function requireXFile(mediaPath: string) {
  const media = await resolveMedia(mediaPath);
  if (media.kind !== "file") throw new ValidationError("X posts need a local media file.");
  if (!isImageMime(media.mime) && !isVideoMime(media.mime)) {
    throw new ValidationError("X media must be an image or a video.");
  }
  return media;
}

function assertCollaboratorsAllowed(mediaType: InstagramKind | undefined, collaborators: readonly string[]): void {
  if (mediaType === "story" && collaborators.length > 0) {
    throw new ValidationError("Instagram Stories do not support collaborator invites. Use a feed image or Reel.");
  }
}

function assertInstagramMedia(media: MediaRef, mediaType: InstagramKind | undefined): void {
  if (media.kind === "url" && media.url.startsWith("http:")) {
    throw new ValidationError("Instagram media URLs must use https.");
  }
  if (mediaType === "image" && media.kind === "file") {
    throw new ValidationError(
      "Instagram photo publishing requires a public https image_url. Local files are uploaded for Reels.",
    );
  }
  if ((mediaType === "reel" || mediaType === undefined) && media.kind === "file" && isImageMime(media.mime)) {
    throw new ValidationError(
      "Instagram photo publishing requires a public https image_url. Pass that URL as mediaPath, or send a video for a Reel.",
    );
  }
}

function requireTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) throw new ValidationError("YouTube posts require a title.");
  if (trimmed.length > YOUTUBE_TITLE) {
    throw new ValidationError(`YouTube title must be at most ${YOUTUBE_TITLE} characters.`);
  }
  return trimmed;
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags || tags.length === 0) return [];
  if (tags.length > 30) throw new ValidationError("YouTube accepts at most 30 tags.");
  const cleaned = tags.map((tag) => tag.trim());
  for (const tag of cleaned) {
    if (!tag) throw new ValidationError("YouTube tags cannot be empty.");
    if (tag.includes(",")) throw new ValidationError("YouTube tags cannot contain commas.");
    if (tag.length > 100) throw new ValidationError("Each YouTube tag must be at most 100 characters.");
  }
  if (cleaned.join(",").length > TAG_TOTAL) {
    throw new ValidationError("YouTube tags must total at most 500 characters.");
  }
  return cleaned;
}

function assertLength(value: string, max: number, label: string): void {
  if (value.length > max) throw new ValidationError(`${label} must be at most ${max} characters.`);
}

function normalizeRunAt(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new ValidationError("runAt must be an ISO 8601 date.");
  return parsed.toISOString();
}

function clampLimit(limit: number, max: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new ValidationError(`limit must be an integer from 1 to ${max}.`);
  }
  return limit;
}
