import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface McpLimits {
  /** Maximum size of a file that can be read or searched, in bytes. */
  maxFileBytes: number;
  /** Maximum number of entries returned by a single list operation. */
  maxListEntries: number;
  /** Maximum number of matches returned by a single search. */
  maxSearchResults: number;
  /** Matching lines longer than this are truncated. */
  maxLineLength: number;
}

export interface McpConfig {
  /** Absolute directory containing per-session repository workspaces. */
  reposDir: string;
  limits: McpLimits;
}

// Repo root resolved from both src/config.ts and dist/config.js.
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ROOT_ENV_FILE = resolve(REPO_ROOT, ".env");

/**
 * The only environment variables the MCP server consumes. Loading just these from
 * `.env` keeps secrets the server never needs (e.g. GEMINI_API_KEY, GITHUB_TOKEN)
 * out of this sandboxed, repo-parsing process (least privilege / defense in depth).
 */
export const MCP_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  "REPOS_TMP_DIR",
  "REPO_MAX_FILE_MB",
  "REPO_MAX_FILES",
  "MCP_MAX_SEARCH_RESULTS",
  "MCP_MAX_LINE_LENGTH",
]);

/**
 * Load the MCP-relevant variables from `.env` without overriding variables already
 * present in the environment. The parent process (the API) passes `REPOS_TMP_DIR`
 * explicitly, and that value must win over any `.env` on disk. Secret-bearing
 * variables (API keys, tokens) are intentionally NOT loaded here — see the allowlist.
 */
export function loadRootEnvFile(
  envFile: string = ROOT_ENV_FILE,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!existsSync(envFile)) return;
  const content = readFileSync(envFile, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!MCP_ENV_ALLOWLIST.has(key)) continue; // Least privilege: ignore everything else.
    if (key in env) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
}

function numberFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const reposDirSetting = env.REPOS_TMP_DIR?.trim() || ".tmp/repos";
  return {
    reposDir: resolve(REPO_ROOT, reposDirSetting),
    limits: {
      maxFileBytes: numberFromEnv(env.REPO_MAX_FILE_MB, 2) * 1024 * 1024,
      maxListEntries: numberFromEnv(env.REPO_MAX_FILES, 5000),
      maxSearchResults: numberFromEnv(env.MCP_MAX_SEARCH_RESULTS, 200),
      maxLineLength: numberFromEnv(env.MCP_MAX_LINE_LENGTH, 300),
    },
  };
}
