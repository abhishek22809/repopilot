import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpConfig } from "../config.js";
import { listProjectFiles } from "../lib/fileOps.js";
import { runTool } from "../lib/result.js";

export function registerListProjectFiles(server: McpServer, config: McpConfig): void {
  server.registerTool(
    "list_project_files",
    {
      title: "List project files",
      description:
        "List files and directories within a connected repository session. " +
        "Returns repo-relative paths, excluding VCS, dependency, build, and secret files.",
      inputSchema: {
        sessionId: z.string().describe("The repository session ID."),
        path: z.string().optional().describe("Optional repo-relative subdirectory to list."),
      },
    },
    async ({ sessionId, path }) => runTool(() => listProjectFiles(config, sessionId, path)),
  );
}
