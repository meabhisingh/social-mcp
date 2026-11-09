import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./env.js";
import { asRecord, NotFoundError, ValidationError } from "./errors.js";
import type { PostRecord } from "./types.js";

const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 15_000;

export async function ensureDataDir(): Promise<string> {
  const dir = dataDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function readAllPosts(): Promise<PostRecord[]> {
  const dir = await ensureDataDir();
  return readPosts(dir);
}

export async function modifyPosts(change: (posts: PostRecord[]) => void): Promise<void> {
  const dir = await ensureDataDir();
  await withLock(dir, async () => {
    const posts = await readPosts(dir);
    change(posts);
    await writePosts(dir, posts);
  });
}

export async function getStoredPost(id: string): Promise<PostRecord> {
  const posts = await readAllPosts();
  const found = posts.find((post) => post.id === id);
  if (!found) throw new NotFoundError(`No post with id ${id}.`);
  return found;
}

async function readPosts(dir: string): Promise<PostRecord[]> {
  const file = path.join(dir, "posts.json");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ValidationError(`The store at ${file} is not valid JSON.`);
  }

  const record = asRecord(parsed);
  if (!record || !Array.isArray(record.posts)) {
    throw new ValidationError(`The store at ${file} is missing a posts array.`);
  }

  return record.posts.map((entry) => {
    const post = asRecord(entry);
    if (!post || typeof post.id !== "string" || typeof post.platform !== "string" || typeof post.status !== "string") {
      throw new ValidationError("The store contains an invalid post record.");
    }
    return entry as PostRecord;
  });
}

async function writePosts(dir: string, posts: PostRecord[]): Promise<void> {
  const file = path.join(dir, "posts.json");
  const temporary = path.join(dir, `.posts.${process.pid}.${Date.now()}.tmp`);
  const body = `${JSON.stringify({ version: 1, posts }, null, 2)}\n`;
  await writeFile(temporary, body, "utf8");
  await rename(temporary, file);
}

async function withLock(dir: string, work: () => Promise<void>): Promise<void> {
  const lockDir = path.join(dir, ".lock");
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const info = await stat(lockDir);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
      }
      if (Date.now() - started > LOCK_WAIT_MS) {
        throw new ValidationError("Timed out waiting for the data directory lock.");
      }
      await delay(25);
    }
  }

  try {
    await work();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function requirePost(posts: PostRecord[], id: string): { index: number; post: PostRecord } {
  const index = posts.findIndex((post) => post.id === id);
  const post = posts[index];
  if (index < 0 || !post) throw new NotFoundError(`No post with id ${id}.`);
  return { index, post };
}
