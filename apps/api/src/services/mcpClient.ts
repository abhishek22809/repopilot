import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { RepoError } from "../utils/RepoError.js";

// Repo root resolved from both src/services and dist/services.
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

export interface McpClientOptions {
  /** Absolute repository workspace directory, shared with the MCP server. */
  reposDir: string;
  nodeEnv: string;
  /** Override the spawn command (used by tests). */
  command?: string;
  args?: string[];
}

export interface McpClient {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

interface ToolEnvelope {
  ok: boolean;
  status?: number;
  error?: string;
  data?: unknown;
}

/** How the API spawns the MCP child. Production uses the compiled server (stdio + disk). */
export function mcpServerLaunchSpec(
  nodeEnv: string,
  repoRoot: string = REPO_ROOT,
): { command: string; args: string[] } {
  if (nodeEnv === "production") {
    return { command: process.execPath, args: [join(repoRoot, "packages/mcp-server/dist/index.js")] };
  }
  // Dev/test: run the TypeScript source directly via the tsx loader (no build needed).
  return {
    command: process.execPath,
    args: ["--import", "tsx", join(repoRoot, "packages/mcp-server/src/index.ts")],
  };
}

export function assertProductionMcpBuild(nodeEnv: string, repoRoot: string = REPO_ROOT): void {
  if (nodeEnv !== "production") return;
  const entry = mcpServerLaunchSpec(nodeEnv, repoRoot).args[0];
  if (!entry || !existsSync(entry)) {
    throw new Error("MCP server build is missing. Run npm run build:backend before starting the API.");
  }
}

export function createMcpClient(options: McpClientOptions): McpClient {
  const spec = options.command
    ? { command: options.command, args: options.args ?? [] }
    : mcpServerLaunchSpec(options.nodeEnv);

  let clientPromise: Promise<Client> | null = null;

  function connect(): Promise<Client> {
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      cwd: REPO_ROOT,
      stderr: "inherit",
      env: { ...getDefaultEnvironment(), REPOS_TMP_DIR: options.reposDir },
    });
    transport.onclose = () => {
      clientPromise = null;
    };
    const client = new Client({ name: "repopilot-api", version: "0.1.0" });
    return client.connect(transport).then(() => client);
  }

  function ensureConnected(): Promise<Client> {
    if (!clientPromise) {
      clientPromise = connect().catch((error) => {
        clientPromise = null;
        throw error;
      });
    }
    return clientPromise;
  }

  async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    let client: Client;
    try {
      client = await ensureConnected();
    } catch {
      throw new RepoError(503, "Repository explorer is temporarily unavailable.");
    }

    let result: CallToolResult;
    try {
      result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    } catch {
      clientPromise = null; // Force a reconnect on the next call.
      throw new RepoError(503, "Repository explorer failed to respond.");
    }

    const block = result.content.find((c) => c.type === "text");
    if (!block || block.type !== "text") {
      throw new RepoError(502, "Malformed response from the repository explorer.");
    }

    let envelope: ToolEnvelope;
    try {
      envelope = JSON.parse(block.text) as ToolEnvelope;
    } catch {
      throw new RepoError(502, "Malformed response from the repository explorer.");
    }

    if (!envelope.ok) {
      throw new RepoError(envelope.status ?? 500, envelope.error ?? "Tool error.");
    }
    return envelope.data;
  }

  async function close(): Promise<void> {
    if (!clientPromise) return;
    const client = await clientPromise.catch(() => null);
    clientPromise = null;
    await client?.close();
  }

  return { callTool, close };
}
