import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadDotEnv } from "../src/env.js";

test("dotenv loader fills missing keys and does not override", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "social-mcp-env-"));
  const file = path.join(dir, ".env");
  await writeFile(file, "SOCIAL_MCP_TEST_NEW=from-file\nSOCIAL_MCP_TEST_SET=from-file\n# comment\n\n");
  const previousNew = process.env.SOCIAL_MCP_TEST_NEW;
  const previousSet = process.env.SOCIAL_MCP_TEST_SET;
  delete process.env.SOCIAL_MCP_TEST_NEW;
  process.env.SOCIAL_MCP_TEST_SET = "already";
  try {
    loadDotEnv(file);
    assert.equal(process.env.SOCIAL_MCP_TEST_NEW, "from-file");
    assert.equal(process.env.SOCIAL_MCP_TEST_SET, "already");
  } finally {
    if (previousNew === undefined) delete process.env.SOCIAL_MCP_TEST_NEW;
    else process.env.SOCIAL_MCP_TEST_NEW = previousNew;
    if (previousSet === undefined) delete process.env.SOCIAL_MCP_TEST_SET;
    else process.env.SOCIAL_MCP_TEST_SET = previousSet;
  }
});

test("dotenv loader ignores a missing file", () => {
  loadDotEnv(path.join(os.tmpdir(), "social-mcp-missing-env"));
});
