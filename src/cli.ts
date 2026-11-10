import path from "node:path";
import { startRunner } from "./run-due.js";
import { startServer } from "./serve.js";

const args = userArgs();

async function main(): Promise<void> {
  if (args.includes("-h") || args.includes("--help")) {
    console.error("usage: social-mcp");
    console.error("       social-mcp due [--watch]");
    return;
  }

  if (args[0] === "due" || args.includes("--due") || args.includes("--watch")) {
    await startRunner();
    return;
  }
  await startServer();
}

void main();

function userArgs(): string[] {
  const argv = process.argv.slice(1);
  const entry = argv[0];
  if (!entry) return [];
  if (/\.(?:cjs|mjs|js|ts)$/.test(entry)) return argv.slice(1);
  if (path.resolve(entry) === path.resolve(process.execPath)) return argv.slice(1);
  return argv;
}
