import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ToolError } from "./errors.js";

/**
 * Run a tool body and wrap it in a structured MCP result. Success and failure are
 * both returned as a single JSON text block: `{ ok, data }` or `{ ok, status, error }`.
 * Errors are marked with `isError` so MCP clients can detect them.
 */
export async function runTool(body: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const data = await body();
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, data }) }] };
  } catch (error) {
    const status = error instanceof ToolError ? error.status : 500;
    const message = error instanceof ToolError ? error.message : "Internal tool error.";
    return {
      content: [{ type: "text", text: JSON.stringify({ ok: false, status, error: message }) }],
      isError: true,
    };
  }
}
