#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, loadRootEnvFile } from "./config.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  loadRootEnvFile();
  const config = loadConfig();
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
  // stdout carries the MCP protocol; log only to stderr.
  console.error("RepoPilot MCP server running on stdio");
}

main().catch((error: unknown) => {
  console.error("Fatal error in RepoPilot MCP server:", error);
  process.exit(1);
});
