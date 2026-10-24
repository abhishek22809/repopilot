import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpConfig } from "../config.js";
import { searchProjectCode } from "../lib/fileOps.js";
import { runTool } from "../lib/result.js";

export function registerSearchProjectCode(server: McpServer, config: McpConfig): void {
  server.registerTool(
    "search_project_code",
    {
      title: "Search project code",
      description:
        "Search text across readable files in a connected repository session. " +
        "Returns relative paths, line numbers, and matching lines. Skips binary, " +
        "oversized, and excluded files.",
      inputSchema: {
        sessionId: z.string().describe("The repository session ID."),
        query: z.string().describe("The text to search for (case-insensitive)."),
        extension: z
          .string()
          .optional()
          .describe("Optional file extension filter, e.g. 'ts' or '.ts'."),
      },
    },
    async ({ sessionId, query, extension }) =>
      runTool(() => searchProjectCode(config, sessionId, query, extension)),
  );
}
