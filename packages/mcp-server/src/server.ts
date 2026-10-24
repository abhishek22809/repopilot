import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, type McpConfig } from "./config.js";
import { registerListProjectFiles } from "./tools/listProjectFiles.js";
import { registerReadProjectFile } from "./tools/readProjectFile.js";
import { registerSearchProjectCode } from "./tools/searchProjectCode.js";

export const SERVER_INFO = {
  name: "repopilot-mcp-server",
  version: "0.1.0",
} as const;

export function createServer(config: McpConfig = loadConfig()): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "RepoPilot exposes read-only tools for exploring a connected public GitHub " +
      "repository: list_project_files, search_project_code, and read_project_file. " +
      "All operations are scoped to a single repository session and never execute code.",
  });

  registerListProjectFiles(server, config);
  registerSearchProjectCode(server, config);
  registerReadProjectFile(server, config);

  return server;
}
