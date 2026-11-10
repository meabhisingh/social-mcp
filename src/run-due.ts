import { loadDotEnv, readEnv } from "./env.js";
import { runDuePosts } from "./posts.js";

export async function startRunner(): Promise<number> {
  loadDotEnv();
  const watch = process.argv.includes("--watch");
  const rawInterval = readEnv("SOCIAL_MCP_POLL_MS");
  const interval = rawInterval === undefined ? 30_000 : Number(rawInterval);

  if (watch && (!Number.isFinite(interval) || interval < 5000)) {
    console.error("SOCIAL_MCP_POLL_MS must be a number >= 5000.");
    process.exit(1);
  }

  async function once(): Promise<number> {
    const result = await runDuePosts();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ran.filter((item) => item.status === "failed").length;
  }

  if (!watch) {
    const failed = await once();
    if (failed > 0) process.exitCode = 1;
    return failed;
  }

  console.error(`social-mcp runner watching every ${interval}ms`);
  for (;;) {
    try {
      await once();
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, interval);
    });
  }
}
