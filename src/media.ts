import { copyFile, mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ValidationError } from "./errors.js";
import { ensureDataDir } from "./store.js";
import type { LocalMedia, MediaRef } from "./types.js";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".3gp": "video/3gpp",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function mimeForExtension(extension: string): string | undefined {
  return MIME_BY_EXTENSION[extension.toLowerCase()];
}

export function isVideoMime(mime: string): boolean {
  return mime.startsWith("video/");
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

export async function resolveMedia(input: string): Promise<MediaRef> {
  const value = input.trim();
  if (!value) throw new ValidationError("mediaPath is required.");

  let parsed: URL | undefined;
  try {
    parsed = new URL(value);
  } catch {
    parsed = undefined;
  }

  if (parsed && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
    if (parsed.protocol !== "https:") {
      throw new ValidationError("Media URLs must use https.");
    }
    if (parsed.username || parsed.password) {
      throw new ValidationError("Media URLs must not include credentials.");
    }
    const extension = path.extname(parsed.pathname).toLowerCase();
    return { kind: "url", url: value, mime: mimeForExtension(extension) };
  }

  if (parsed) {
    throw new ValidationError("mediaPath must be a local file path or an https URL.");
  }

  const resolved = path.resolve(value);
  let real: string;
  try {
    real = await realpath(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new ValidationError(`Media file not found: ${resolved}`);
    throw new ValidationError(`Cannot read media file: ${resolved}`);
  }

  const info = await stat(real);
  if (!info.isFile()) throw new ValidationError("mediaPath must be a file or an https URL.");
  if (info.size <= 0) throw new ValidationError("Media file is empty.");
  if (path.basename(real) === "posts.json") {
    throw new ValidationError("mediaPath must be a media file.");
  }

  const extension = path.extname(real).toLowerCase();
  const mime = mimeForExtension(extension);
  if (!mime) {
    throw new ValidationError(
      `Unsupported media extension "${extension || "(none)"}". Use a video or image file.`,
    );
  }

  return {
    kind: "file",
    path: real,
    size: info.size,
    mime,
    filename: path.basename(real),
  };
}

/**
 * Keep a local file inside the data directory. Files already stored there are left in place.
 * Returns the absolute path the post record should keep.
 */
export async function retainLocalMedia(id: string, filePath: string): Promise<string> {
  const root = await ensureDataDir();
  const realRoot = await realpath(root);
  const realFile = await realpath(filePath);
  const relative = path.relative(realRoot, realFile);
  if (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return realFile;
  }

  const mediaDir = path.join(root, "media");
  await mkdir(mediaDir, { recursive: true });
  const destination = path.join(mediaDir, `${id}${path.extname(realFile).toLowerCase()}`);
  await copyFile(realFile, destination);
  return realpath(destination);
}
