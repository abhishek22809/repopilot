import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertProductionMcpBuild, mcpServerLaunchSpec } from "../src/services/mcpClient.js";

describe("mcpServerLaunchSpec", () => {
  it("spawns the compiled MCP server over stdio in production", () => {
    const spec = mcpServerLaunchSpec("production", "/repo");
    expect(spec.args).toEqual([join("/repo", "packages/mcp-server/dist/index.js")]);
    expect(spec.args[0]).not.toContain("tsx");
  });

  it("uses the TypeScript source under tsx outside production", () => {
    const spec = mcpServerLaunchSpec("development", "/repo");
    expect(spec.args).toEqual(["--import", "tsx", join("/repo", "packages/mcp-server/src/index.ts")]);
  });

  it("fails fast in production when the MCP build is missing", () => {
    expect(() => assertProductionMcpBuild("production", "/definitely-missing-repopilot-root")).toThrow(
      /MCP server build is missing/,
    );
    expect(() => assertProductionMcpBuild("development", "/definitely-missing-repopilot-root")).not.toThrow();
  });
});
