import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ValidationError } from "../src/errors.js";
import { normalizeCollaborators } from "../src/platforms/instagram.js";
import {
  cancelScheduled,
  getPost,
  listPublished,
  listScheduled,
  postInstagram,
  postX,
  postYouTube,
  runDuePosts,
  schedulePost,
} from "../src/posts.js";
import { resetYouTubeTokenCache } from "../src/platforms/youtube.js";
import { isolateEnv, listen, localFetch, readBody, removeDir, tempDir } from "./helpers.js";

test("schedule, list, get, and cancel stay in the local store", async () => {
  const root = await tempDir("social-mcp-store-");
  const outside = await tempDir("social-mcp-src-");
  const video = path.join(outside, "clip.mp4");
  await writeFile(video, Buffer.from("video"));
  const restore = isolateEnv({
    SOCIAL_MCP_DATA_DIR: root,
    YOUTUBE_ACCESS_TOKEN: "super-secret-token-value",
  });
  try {
    const scheduled = await schedulePost({
      platform: "youtube",
      title: "Later",
      content: "Description",
      mediaPath: video,
      runAt: "2026-12-01T15:00:00Z",
      privacyStatus: "public",
    });
    assert.equal(scheduled.status, "scheduled");
    assert.equal(scheduled.platform, "youtube");
    assert.ok(scheduled.mediaPath.includes(`${path.sep}media${path.sep}`));
    const listed = await listScheduled();
    assert.equal(listed.posts.length, 1);
    assert.equal(listed.posts[0]?.id, scheduled.id);
    const fetched = await getPost(scheduled.id);
    assert.equal(fetched.title, "Later");
    const cancelled = await cancelScheduled(scheduled.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal((await listScheduled()).posts.length, 0);
    const raw = await readFile(path.join(root, "posts.json"), "utf8");
    assert.equal(raw.includes("super-secret-token-value"), false);
    await assert.rejects(() => cancelScheduled(scheduled.id), ValidationError);
  } finally {
    restore();
    await removeDir(root);
    await removeDir(outside);
  }
});

test("run due posts records a failure without credentials and does not store secrets", async () => {
  const root = await tempDir("social-mcp-due-");
  const outside = await tempDir("social-mcp-due-src-");
  const image = path.join(outside, "photo.jpg");
  await writeFile(image, Buffer.from("jpeg"));
  const restore = isolateEnv({ SOCIAL_MCP_DATA_DIR: root });
  try {
    const scheduled = await schedulePost({
      platform: "x",
      content: "Hello",
      mediaPath: image,
      runAt: "2020-01-01T00:00:00Z",
    });
    const result = await runDuePosts({ now: new Date("2026-01-01T00:00:00Z") });
    assert.equal(result.ran.length, 1);
    assert.equal(result.ran[0]?.id, scheduled.id);
    assert.equal(result.ran[0]?.status, "failed");
    assert.match(result.ran[0]?.error ?? "", /X credentials missing/);
    const stored = await getPost(scheduled.id);
    assert.equal(stored.status, "failed");
    assert.equal((await listPublished()).posts.length, 0);
  } finally {
    restore();
    await removeDir(root);
    await removeDir(outside);
  }
});

test("run due posts publishes against the local X API and returns both ids", async () => {
  const root = await tempDir("social-mcp-due-ok-");
  const outside = await tempDir("social-mcp-due-ok-src-");
  const image = path.join(outside, "photo.jpg");
  await writeFile(image, Buffer.from("jpeg-bytes"));
  const restore = isolateEnv({
    SOCIAL_MCP_DATA_DIR: root,
    X_OAUTH2_ACCESS_TOKEN: "x-user-token",
  });
  const server = await listen(async (request, response) => {
    const host = request.headers.host ?? "127.0.0.1";
    const url = new URL(request.url ?? "/", `http://${host}`);
    const body = await readBody(request);
    response.setHeader("Content-Type", "application/json");
    if (url.searchParams.get("command") === "INIT") {
      response.end(JSON.stringify({ data: { id: "media-9" } }));
      return;
    }
    if (url.searchParams.get("command") === "FINALIZE") {
      response.end(JSON.stringify({ data: { id: "media-9" } }));
      return;
    }
    if (url.pathname === "/2/tweets") {
      const payload = JSON.parse(body.toString()) as { text: string };
      assert.equal(payload.text, "Due now");
      response.end(JSON.stringify({ data: { id: "tweet-9" } }));
      return;
    }
    response.end(JSON.stringify({ data: {} }));
  });
  try {
    const scheduled = await schedulePost({
      platform: "x",
      content: "Due now",
      mediaPath: image,
      runAt: "2020-01-01T00:00:00Z",
    });
    const result = await runDuePosts({
      now: new Date("2026-01-01T00:00:00Z"),
      net: { fetchImpl: localFetch(server.origin), xApiBase: server.origin },
    });
    assert.equal(result.ran[0]?.status, "published");
    assert.equal(result.ran[0]?.platformId, "tweet-9");
    assert.equal(result.ran[0]?.id, scheduled.id);
    const published = await listPublished();
    assert.equal(published.posts[0]?.platformId, "tweet-9");
    const raw = await readFile(path.join(root, "posts.json"), "utf8");
    assert.equal(raw.includes("x-user-token"), false);
  } finally {
    restore();
    await server.close();
    await removeDir(root);
    await removeDir(outside);
  }
});

test("post now rejects a photo for youtube and returns the local id when upload fails", async () => {
  resetYouTubeTokenCache();
  const root = await tempDir("social-mcp-post-");
  const outside = await tempDir("social-mcp-post-src-");
  await writeFile(path.join(outside, "pic.jpg"), Buffer.from("jpeg"));
  await writeFile(path.join(outside, "clip.mp4"), Buffer.from("video"));
  const restore = isolateEnv({
    SOCIAL_MCP_DATA_DIR: root,
    YOUTUBE_ACCESS_TOKEN: "ya-test-token",
  });
  const server = await listen(async (request, response) => {
    await readBody(request);
    response.writeHead(403, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "quota" } }));
  });
  try {
    await assert.rejects(
      () => postYouTube({ title: "T", content: "", mediaPath: path.join(outside, "pic.jpg") }),
      /local video file/,
    );
    await assert.rejects(
      () =>
        postYouTube(
          { title: "T", content: "d", mediaPath: path.join(outside, "clip.mp4") },
          { fetchImpl: localFetch(server.origin), youtubeApiBase: server.origin },
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /quota/);
        assert.match(error.message, /yt|YouTube|403/);
        const localId = "localId" in error ? (error as { localId?: string }).localId : undefined;
        assert.equal(typeof localId, "string");
        return true;
      },
    );
    const raw = await readFile(path.join(root, "posts.json"), "utf8");
    assert.equal(raw.includes("ya-test-token"), false);
    assert.match(raw, /"status": "failed"/);
  } finally {
    restore();
    resetYouTubeTokenCache();
    await server.close();
    await removeDir(root);
    await removeDir(outside);
  }
});

test("instagram collaborators are validated, stored, and invited when a due post runs", async () => {
  assert.deepEqual(normalizeCollaborators([" @Ada ", "ada", "Bob"]), ["Ada", "Bob"]);
  assert.throws(() => normalizeCollaborators(["bad name"]), ValidationError);
  assert.throws(() => normalizeCollaborators(["one", "two", "three", "four"]), /at most 3/);
  assert.throws(() => normalizeCollaborators([".leading"]), ValidationError);

  const root = await tempDir("social-mcp-ig-collab-");
  const restore = isolateEnv({
    SOCIAL_MCP_DATA_DIR: root,
    INSTAGRAM_ACCESS_TOKEN: "ig-token-value",
    INSTAGRAM_USER_ID: "ig-user",
  });
  const invited: string[][] = [];
  const server = await listen(async (request, response) => {
    const host = request.headers.host ?? "127.0.0.1";
    const url = new URL(request.url ?? "/", `http://${host}`);
    const body = (await readBody(request)).toString();
    response.setHeader("Content-Type", "application/json");
    if (request.method === "POST" && url.pathname.endsWith("/media")) {
      const params = new URLSearchParams(body);
      invited.push(JSON.parse(params.get("collaborators") ?? "[]") as string[]);
      response.end(JSON.stringify({ id: "container-due" }));
      return;
    }
    if (request.method === "GET") {
      response.end(JSON.stringify({ status_code: "FINISHED" }));
      return;
    }
    assert.equal(new URLSearchParams(body).get("collaborators"), null);
    response.end(JSON.stringify({ id: "ig-media-due" }));
  });
  try {
    await assert.rejects(
      () =>
        schedulePost({
          platform: "instagram",
          content: "Story",
          mediaPath: "https://cdn.example.com/pic.jpg",
          mediaType: "story",
          runAt: "2020-01-01T00:00:00Z",
          collaborators: ["Ada"],
        }),
      /Stories do not support/,
    );
    await assert.rejects(
      () =>
        schedulePost({
          platform: "youtube",
          title: "No",
          content: "",
          mediaPath: "https://cdn.example.com/pic.jpg",
          runAt: "2020-01-01T00:00:00Z",
          collaborators: ["Ada"],
        }),
      /only supported for Instagram/,
    );
    const scheduled = await schedulePost({
      platform: "instagram",
      content: "With friends",
      mediaPath: "https://cdn.example.com/pic.jpg",
      runAt: "2020-01-01T00:00:00Z",
      collaborators: ["@Ada", "Bob"],
    });
    assert.deepEqual(scheduled.collaborators, ["Ada", "Bob"]);
    const stored = await getPost(scheduled.id);
    assert.deepEqual(stored.collaborators, ["Ada", "Bob"]);
    const ran = await runDuePosts({
      now: new Date("2026-01-01T00:00:00Z"),
      net: { fetchImpl: localFetch(server.origin), instagramGraphBase: `${server.origin}/v22.0` },
    });
    assert.equal(ran.ran[0]?.status, "published");
    assert.equal(ran.ran[0]?.platformId, "ig-media-due");
    assert.deepEqual(ran.ran[0]?.invitesSent, ["Ada", "Bob"]);
    const published = await postInstagram(
      { content: "Now", mediaPath: "https://cdn.example.com/pic.jpg", collaborators: ["Ada"] },
      { fetchImpl: localFetch(server.origin), instagramGraphBase: `${server.origin}/v22.0` },
    );
    assert.deepEqual(published.invitesSent, ["Ada"]);
    assert.equal(published.platformId, "ig-media-due");
    assert.deepEqual(invited, [
      ["Ada", "Bob"],
      ["Ada"],
    ]);
  } finally {
    restore();
    await server.close();
    await removeDir(root);
  }
});

test("text-only X post skips media upload", async () => {
  const root = await tempDir("social-mcp-text-");
  const restore = isolateEnv({
    SOCIAL_MCP_DATA_DIR: root,
    X_OAUTH2_ACCESS_TOKEN: "x-user-token",
  });
  const calls: string[] = [];
  const server = await listen(async (request, response) => {
    const host = request.headers.host ?? "127.0.0.1";
    const url = new URL(request.url ?? "/", `http://${host}`);
    calls.push(url.pathname);
    await readBody(request);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: { id: "tweet-text" } }));
  });
  try {
    const result = await postX({ content: "Only text" }, { fetchImpl: localFetch(server.origin), xApiBase: server.origin });
    assert.equal(result.platformId, "tweet-text");
    assert.equal(result.id.length > 0, true);
    assert.deepEqual(calls, ["/2/tweets"]);
    const stored = await getPost(result.id);
    assert.equal(stored.platformId, "tweet-text");
    assert.equal(stored.status, "published");
  } finally {
    restore();
    await server.close();
    await removeDir(root);
  }
});
