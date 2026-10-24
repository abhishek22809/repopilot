import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpConfig } from "../config.js";
import { readProjectFile } from "../lib/fileOps.js";
import { runTool } from "../lib/result.js";

export function registerReadProjectFile(server: McpServer, config: McpConfig): void {
  server.registerTool(
    "read_project_file",
    {
      title: "Read project file",
      description:
        "Read a single file from a connected repository session. Returns the file " +
        "contents and line count. Rejects absolute paths, traversal, symlinks, secret " +
        "files, and oversized files.",
      inputSchema: {
        sessionId: z.string().describe("The repository session ID."),
        path: z.string().describe("The repo-relative file path to read."),
      },
    },
    async ({ sessionId, path }) => runTool(() => readProjectFile(config, sessionId, path)),
  );
}
