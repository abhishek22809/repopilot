import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRootEnvFile } from "../src/config.js";

let dir: string;
let envFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "repopilot-env-"));
  envFile = join(dir, ".env");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadRootEnvFile (least privilege)", () => {
  it("loads only MCP-relevant vars and never secrets like GEMINI_API_KEY / GITHUB_TOKEN", async () => {
    await writeFile(
      envFile,
      [
        "REPOS_TMP_DIR=/tmp/custom",
        "MCP_MAX_SEARCH_RESULTS=42",
        "GEMINI_API_KEY=super-secret-key",
        "GITHUB_TOKEN=ghp_secrettoken",
        "AI_API_KEY=another-secret",
      ].join("\n"),
    );
    const env: NodeJS.ProcessEnv = {};

    loadRootEnvFile(envFile, env);

    // Allowlisted config is loaded.
    expect(env.REPOS_TMP_DIR).toBe("/tmp/custom");
    expect(env.MCP_MAX_SEARCH_RESULTS).toBe("42");
    // Secrets the MCP server never needs are NOT loaded into its process.
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.AI_API_KEY).toBeUndefined();
  });

  it("does not override a value the parent process already set", async () => {
    await writeFile(envFile, "REPOS_TMP_DIR=/tmp/from-file");
    const env: NodeJS.ProcessEnv = { REPOS_TMP_DIR: "/tmp/from-parent" };

    loadRootEnvFile(envFile, env);

    expect(env.REPOS_TMP_DIR).toBe("/tmp/from-parent");
  });

  it("is a no-op when the env file does not exist", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(() => loadRootEnvFile(join(dir, "nope.env"), env)).not.toThrow();
    expect(Object.keys(env)).toHaveLength(0);
  });
});
