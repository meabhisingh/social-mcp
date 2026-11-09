import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { publishInstagram } from "../src/platforms/instagram.js";
import { publishX } from "../src/platforms/x.js";
import { publishYouTube, resetYouTubeTokenCache } from "../src/platforms/youtube.js";
import { resolveMedia } from "../src/media.js";
import { isolateEnv, listen, localFetch, readBody, removeDir, tempDir } from "./helpers.js";

test("youtube resumable upload sends metadata then ranged chunks", async () => {
  resetYouTubeTokenCache();
  const dir = await tempDir("social-mcp-yt-");
  const file = path.join(dir, "clip.mp4");
  await writeFile(file, Buffer.from("0123456789"));
  const media = await resolveMedia(file);
  assert.equal(media.kind, "file");
  if (media.kind !== "file") return;

  let received = 0;
  const restore = isolateEnv({ YOUTUBE_ACCESS_TOKEN: "ya-test-token" });
  const server = await listen(async (request, response) => {
    const host = request.headers.host ?? "127.0.0.1";
    const url = new URL(request.url ?? "/", `http://${host}`);
    if (request.method === "POST" && url.pathname === "/upload/youtube/v3/videos") {
      assert.equal(url.searchParams.get("uploadType"), "resumable");
      assert.equal(url.searchParams.get("part"), "snippet,status");
      assert.equal(request.headers.authorization, "Bearer ya-test-token");
      assert.equal(request.headers["x-upload-content-length"], "10");
      assert.equal(request.headers["x-upload-content-type"], "video/mp4");
      const payload = JSON.parse((await readBody(request)).toString()) as {
        snippet: { title: string; description: string };
        status: { privacyStatus: string; selfDeclaredMadeForKids: boolean };
      };
      assert.equal(payload.snippet.title, "Demo");
      assert.equal(payload.snippet.description, "Hello");
      assert.equal(payload.status.privacyStatus, "private");
      assert.equal(payload.status.selfDeclaredMadeForKids, false);
      response.writeHead(200, { Location: `http://${host}/session`, "Content-Length": "0" });
      response.end();
      return;
    }
    if (request.method === "PUT" && url.pathname === "/session") {
      const chunk = await readBody(request);
      const header = String(request.headers["content-range"] ?? "");
      const match = /^bytes (\d+)-(\d+)\/10$/.exec(header);
      assert.ok(match, header);
      assert.equal(Number(match[1]), received);
      assert.equal(chunk.length, Number(match[2]) - Number(match[1]) + 1);
      received += chunk.length;
      if (received < 10) {
        response.writeHead(308, { Range: `bytes=0-${received - 1}`, "Content-Length": "0" });
        response.end();
        return;
      }
      assert.equal(chunk.toString(), "89");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ id: "yt-video-1" }));
      return;
    }
    response.writeHead(404);
    response.end();
  });

  try {
    const result = await publishYouTube(
      {
        title: "Demo",
        description: "Hello",
        media,
        privacyStatus: "private",
        categoryId: "22",
        tags: [],
        madeForKids: false,
        chunkBytes: 4,
      },
      { fetchImpl: localFetch(server.origin), youtubeApiBase: server.origin },
    );
    assert.equal(result.platformId, "yt-video-1");
    assert.equal(received, 10);
  } finally {
    restore();
    resetYouTubeTokenCache();
    await server.close();
    await removeDir(dir);
  }
});

test("youtube refresh token is exchanged before the upload", async () => {
  resetYouTubeTokenCache();
  const dir = await tempDir("social-mcp-yt-refresh-");
  const file = path.join(dir, "clip.mp4");
  await writeFile(file, Buffer.from("abcd"));
  const media = await resolveMedia(file);
  if (media.kind !== "file") return;
  const restore = isolateEnv({
    YOUTUBE_CLIENT_ID: "client-id",
    YOUTUBE_CLIENT_SECRET: "client-secret-value",
    YOUTUBE_REFRESH_TOKEN: "refresh-token-value",
  });
  let sawRefresh = false;
  const server = await listen(async (request, response) => {
    const host = request.headers.host ?? "127.0.0.1";
    const url = new URL(request.url ?? "/", `http://${host}`);
    if (url.pathname === "/token") {
      const body = (await readBody(request)).toString();
      assert.match(body, /refresh_token=refresh-token-value/);
      assert.equal(request.headers.authorization, undefined);
      sawRefresh = true;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ access_token: "ya-refreshed", expires_in: 3600, token_type: "Bearer" }));
      return;
    }
    if (request.method === "POST") {
      assert.equal(request.headers.authorization, "Bearer ya-refreshed");
      await readBody(request);
      response.writeHead(200, { Location: `http://${host}/session` });
      response.end();
      return;
    }
    await readBody(request);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ id: "yt-refreshed" }));
  });
  try {
    const result = await publishYouTube(
      {
        title: "Demo",
        description: "",
        media,
        privacyStatus: "unlisted",
        categoryId: "22",
        tags: ["one"],
        madeForKids: false,
      },
      {
        fetchImpl: localFetch(server.origin),
        youtubeApiBase: server.origin,
        youtubeTokenUrl: `${server.origin}/token`,
      },
    );
    assert.equal(sawRefresh, true);
    assert.equal(result.platformId, "yt-refreshed");
  } finally {
    restore();
    resetYouTubeTokenCache();
    await server.close();
    await removeDir(dir);
  }
});

test("instagram image uses container then publish", async () => {
  const restore = isolateEnv({
    INSTAGRAM_ACCESS_TOKEN: "ig-token-value",
    INSTAGRAM_USER_ID: "ig-user",
  });
  const calls: string[] = [];
  const server = await listen(async (request, response) => {
    const host = request.headers.host ?? "127.0.0.1";
    const url = new URL(request.url ?? "/", `http://${host}`);
    const body = (await readBody(request)).toString();
    calls.push(`${request.method} ${url.pathname}`);
    response.setHeader("Content-Type", "application/json");
    if (request.method === "POST" && url.pathname.endsWith("/media")) {
      const params = new URLSearchParams(body);
      assert.equal(params.get("access_token"), "ig-token-value");
      assert.equal(params.get("image_url"), "https://cdn.example.com/pic.jpg");
      assert.equal(params.get("caption"), "Hello");
      response.end(JSON.stringify({ id: "container-img" }));
      return;
    }
    if (request.method === "GET") {
      assert.equal(url.searchParams.get("fields"), "status_code,status");
      response.end(JSON.stringify({ id: "container-img", status_code: "FINISHED" }));
      return;
    }
    if (url.pathname.endsWith("/media_publish")) {
      const params = new URLSearchParams(body);
      assert.equal(params.get("creation_id"), "container-img");
      response.end(JSON.stringify({ id: "ig-media-1" }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  try {
    const media = await resolveMedia("https://cdn.example.com/pic.jpg");
    const result = await publishInstagram(
      { caption: "Hello", media, mediaType: "image", shareToFeed: undefined, altText: undefined },
      { fetchImpl: localFetch(server.origin), instagramGraphBase: `${server.origin}/v22.0` },
    );
    assert.equal(result.platformId, "ig-media-1");
    assert.equal(result.containerId, "container-img");
    assert.deepEqual(calls, [
      "POST /v22.0/ig-user/media",
      "GET /v22.0/container-img",
      "POST /v22.0/ig-user/media_publish",
    ]);
  } finally {
    restore();
    await server.close();
  }
});

test("instagram reel uploads local bytes then publishes the container", async () => {
  const dir = await tempDir("social-mcp-ig-");
  const file = path.join(dir, "reel.mp4");
  await writeFile(file, Buffer.from("reel-bytes"));
  const media = await resolveMedia(file);
  if (media.kind !== "file") return;
  const restore = isolateEnv({
    INSTAGRAM_ACCESS_TOKEN: "ig-token-value",
    INSTAGRAM_USER_ID: "ig-user",
  });
  const calls: string[] = [];
  const server = await listen(async (request, response) => {
    const host = request.headers.host ?? "127.0.0.1";
    const url = new URL(request.url ?? "/", `http://${host}`);
    calls.push(`${request.method} ${url.pathname}`);
    if (request.method === "POST" && url.pathname.endsWith("/media")) {
      const params = new URLSearchParams((await readBody(request)).toString());
      assert.equal(params.get("upload_type"), "resumable");
      assert.equal(params.get("media_type"), "REELS");
      assert.equal(params.get("share_to_feed"), "true");
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ id: "container-vid", uri: `http://${host}/ig-api-upload/v22.0/container-vid` }));
      return;
    }
    if (url.pathname === "/ig-api-upload/v22.0/container-vid") {
      assert.equal(request.headers.authorization, "OAuth ig-token-value");
      assert.equal(request.headers.offset, "0");
      assert.equal(request.headers.file_size, String(media.size));
      const uploaded = await readBody(request);
      assert.equal(uploaded.toString(), "reel-bytes");
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ success: true, message: "Upload successful." }));
      return;
    }
    if (request.method === "GET") {
      await readBody(request);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ status_code: "FINISHED" }));
      return;
    }
    const params = new URLSearchParams((await readBody(request)).toString());
    assert.equal(params.get("creation_id"), "container-vid");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ id: "ig-media-2" }));
  });
  try {
    const result = await publishInstagram(
      { caption: "Reel", media, mediaType: "reel", shareToFeed: true, altText: undefined },
      {
        fetchImpl: localFetch(server.origin),
        instagramGraphBase: `${server.origin}/v22.0`,
        instagramUploadBase: server.origin,
      },
    );
    assert.equal(result.platformId, "ig-media-2");
    assert.deepEqual(calls, [
      "POST /v22.0/ig-user/media",
      "POST /ig-api-upload/v22.0/container-vid",
      "GET /v22.0/container-vid",
      "POST /v22.0/ig-user/media_publish",
    ]);
  } finally {
    restore();
    await server.close();
    await removeDir(dir);
  }
});

test("x uploads media in chunks and then creates the post", async () => {
  const dir = await tempDir("social-mcp-x-");
  const file = path.join(dir, "photo.jpg");
  await writeFile(file, Buffer.from("jpeg-bytes"));
  const media = await resolveMedia(file);
  if (media.kind !== "file") return;
  const restore = isolateEnv({ X_OAUTH2_ACCESS_TOKEN: "x-user-token" });
  const calls: string[] = [];
  const server = await listen(async (request, response) => {
    const host = request.headers.host ?? "127.0.0.1";
    const url = new URL(request.url ?? "/", `http://${host}`);
    calls.push(`${request.method} ${url.pathname}?${url.searchParams.get("command") ?? ""}`);
    assert.equal(request.headers.authorization, "Bearer x-user-token");
    const body = await readBody(request);
    response.setHeader("Content-Type", "application/json");
    if (url.searchParams.get("command") === "INIT") {
      assert.equal(url.searchParams.get("media_type"), "image/jpeg");
      assert.equal(url.searchParams.get("media_category"), "tweet_image");
      assert.equal(url.searchParams.get("total_bytes"), String(media.size));
      response.end(JSON.stringify({ data: { id: "media-1" } }));
      return;
    }
    if (url.searchParams.get("command") === "FINALIZE") {
      response.end(JSON.stringify({ data: { id: "media-1", processing_info: { state: "pending", check_after_secs: 0 } } }));
      return;
    }
    if (url.searchParams.get("command") === "STATUS") {
      response.end(JSON.stringify({ data: { processing_info: { state: "succeeded" } } }));
      return;
    }
    if (url.pathname === "/2/tweets") {
      const payload = JSON.parse(body.toString()) as { text: string; media: { media_ids: string[] } };
      assert.equal(payload.text, "Hi");
      assert.deepEqual(payload.media.media_ids, ["media-1"]);
      response.end(JSON.stringify({ data: { id: "tweet-1", text: "Hi" } }));
      return;
    }
    assert.ok(body.includes("jpeg-bytes"));
    assert.ok(body.toString().includes("segment_index"));
    response.end(JSON.stringify({ data: {} }));
  });
  try {
    const result = await publishX(
      { text: "Hi", media },
      { fetchImpl: localFetch(server.origin), xApiBase: server.origin },
    );
    assert.equal(result.platformId, "tweet-1");
    assert.equal(result.mediaId, "media-1");
    assert.deepEqual(calls, [
      "POST /2/media/upload?INIT",
      "POST /2/media/upload?",
      "POST /2/media/upload?FINALIZE",
      "GET /2/media/upload?STATUS",
      "POST /2/tweets?",
    ]);
  } finally {
    restore();
    await server.close();
    await removeDir(dir);
  }
});

test("x oauth 1.0a user context signs upload and post requests", async () => {
  const dir = await tempDir("social-mcp-x-oauth-");
  const file = path.join(dir, "photo.png");
  await writeFile(file, Buffer.from("png"));
  const media = await resolveMedia(file);
  if (media.kind !== "file") return;
  const restore = isolateEnv({
    X_API_KEY: "test-consumer",
    X_API_SECRET: "consumer-secret-value",
    X_ACCESS_TOKEN: "user-access-token",
    X_ACCESS_TOKEN_SECRET: "user-token-secret",
  });
  const server = await listen(async (request, response) => {
    const host = request.headers.host ?? "127.0.0.1";
    const url = new URL(request.url ?? "/", `http://${host}`);
    const authorization = String(request.headers.authorization ?? "");
    assert.match(authorization, /^OAuth /);
    assert.match(authorization, /oauth_consumer_key="test-consumer"/);
    await readBody(request);
    response.setHeader("Content-Type", "application/json");
    if (url.searchParams.get("command") === "INIT") {
      response.end(JSON.stringify({ data: { id: "media-oa" } }));
      return;
    }
    if (url.searchParams.get("command") === "FINALIZE") {
      response.end(JSON.stringify({ data: { id: "media-oa" } }));
      return;
    }
    if (url.pathname === "/2/tweets") {
      response.end(JSON.stringify({ data: { id: "tweet-oa" } }));
      return;
    }
    response.end(JSON.stringify({ data: {} }));
  });
  try {
    const result = await publishX(
      { text: "Signed", media },
      { fetchImpl: localFetch(server.origin), xApiBase: server.origin },
    );
    assert.equal(result.platformId, "tweet-oa");
  } finally {
    restore();
    await server.close();
    await removeDir(dir);
  }
});
