import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const { inject } = createRequire(import.meta.url)("postject");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const blob = path.join(dist, "sea-prep.blob");
const binaryName = process.platform === "win32" ? "social-mcp.exe" : "social-mcp";
const binary = path.join(dist, binaryName);
const fuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

mkdirSync(dist, { recursive: true });

await esbuild.build({
  absWorkingDir: root,
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: "dist/sea.cjs",
  legalComments: "none",
  logLevel: "info",
});

const sea = spawnSync(process.execPath, ["--experimental-sea-config", path.join(root, "sea-config.json")], {
  cwd: root,
  stdio: "inherit",
});
if (sea.status !== 0) process.exit(sea.status ?? 1);

copyFileSync(process.execPath, binary);
if (process.platform === "darwin") {
  spawnSync("codesign", ["--remove-signature", binary], { stdio: "inherit" });
}

await inject(binary, "NODE_SEA_BLOB", readFileSync(blob), {
  sentinelFuse: fuse,
  ...(process.platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
});

if (process.platform === "darwin") {
  spawnSync("codesign", ["--sign", "-", binary], { stdio: "inherit" });
}

chmodSync(binary, 0o755);
console.error(`Wrote ${binary}`);
