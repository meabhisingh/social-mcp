import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadDotEnv } from "./env.js";
import { createServer } from "./server.js";

export async function startServer(): Promise<void> {
  loadDotEnv();
  const server = createServer();
  const transport = new StdioServerTransport();
  try {
    await server.connect(transport);
    console.error("social-mcp listening on stdio");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
