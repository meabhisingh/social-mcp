import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TOOL_NAMES = [
  "post_youtube",
  "post_instagram",
  "post_x",
  "schedule_post",
  "list_scheduled_posts",
  "get_post",
  "cancel_scheduled_post",
  "run_due_posts",
  "list_published_posts",
];

test("stdio server lists tools and schedules without calling a platform", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "social-mcp-smoke-"));
  const mediaDir = await mkdtemp(path.join(os.tmpdir(), "social-mcp-smoke-media-"));
  const mediaPath = path.join(mediaDir, "photo.jpg");
  await writeFile(mediaPath, Buffer.from("jpeg"));
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.resolve("dist/index.js")],
    env: { SOCIAL_MCP_DATA_DIR: root },
    stderr: "pipe",
  });
  const client = new Client({ name: "social-mcp-smoke", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      [...TOOL_NAMES].sort(),
    );

    const scheduled = await callTool(client, "schedule_post", {
      platform: "x",
      content: "Later",
      mediaPath,
      runAt: "2026-12-01T15:00:00Z",
    });
    assert.equal(scheduled.status, "scheduled");
    assert.equal(typeof scheduled.id, "string");

    const rows = await callTool(client, "list_scheduled_posts", {});
    assert.equal(rows.posts.length, 1);

    const one = await callTool(client, "get_post", { id: scheduled.id });
    assert.equal(one.id, scheduled.id);

    const cancelled = await callTool(client, "cancel_scheduled_post", { id: scheduled.id });
    assert.equal(cancelled.status, "cancelled");

    const past = await callTool(client, "schedule_post", {
      platform: "x",
      content: "Due",
      mediaPath,
      runAt: "2020-01-01T00:00:00Z",
    });
    const ran = await callTool(client, "run_due_posts", {});
    assert.equal(ran.ran[0].id, past.id);
    assert.equal(ran.ran[0].status, "failed");
    assert.match(ran.ran[0].error, /credentials/i);

    const published = await callTool(client, "list_published_posts", {});
    assert.deepEqual(published.posts, []);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
    await rm(mediaDir, { recursive: true, force: true });
  }
});

async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.find((block) => block && block.type === "text")?.text ?? "";
  const body = text ? JSON.parse(text) : {};
  if (result.isError) {
    throw new Error(`${name} failed: ${text}`);
  }
  return body;
}
