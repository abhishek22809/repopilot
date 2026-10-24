import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface RepoLimits {
  /** Hard cap on the downloaded tarball size, in bytes. */
  maxDownloadBytes: number;
  /** Files larger than this are skipped during extraction, in bytes. */
  maxFileBytes: number;
  /** Maximum number of files extracted per repository. */
  maxFiles: number;
  /** Abort the download if it takes longer than this, in milliseconds. */
  downloadTimeoutMs: number;
}

export interface GeminiConfig {
  /** Gemini API key. Optional: when unset, repo browsing works but Ask is disabled. */
  apiKey: string | undefined;
  /** Model id, configurable via GEMINI_MODEL. */
  model: string;
  /** Abort the AI request after this many milliseconds. */
  timeoutMs: number;
}

export interface RateLimitConfig {
  /** Sliding window length, in milliseconds. */
  windowMs: number;
  /** Max repository connection requests per IP per window. */
  connectMax: number;
  /** Max repository browsing requests (files/search/file) per IP per window. */
  browseMax: number;
}

export interface ApiConfig {
  nodeEnv: string;
  port: number;
  webOrigin: string;
  /** Absolute directory where repository workspaces are created. */
  reposDir: string;
  /** How long a connected repository session lives, in milliseconds. */
  sessionTtlMs: number;
  /** Optional GitHub token to raise API rate limits (never sent to the client). */
  githubToken: string | undefined;
  limits: RepoLimits;
  gemini: GeminiConfig;
  rateLimit: RateLimitConfig;
  /**
   * Express `trust proxy` setting. Controls whether `X-Forwarded-For` is honored for
   * `req.ip` (used by the rate limiter). Default `false` (do NOT trust the header).
   * Behind a known proxy (e.g. Render), set `TRUST_PROXY` to the hop count.
   */
  trustProxy: number | boolean;
}

// Resolves to the monorepo root from both src/utils and dist/utils.
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const ROOT_ENV_FILE = fileURLToPath(new URL("../../../../.env", import.meta.url));

export function loadRootEnvFile(): void {
  if (existsSync(ROOT_ENV_FILE)) {
    process.loadEnvFile(ROOT_ENV_FILE);
  }
}

function numberFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid numeric env value: ${raw}`);
  }
  return value;
}

/**
 * Parse the `TRUST_PROXY` env var. Default `false` (never trust forwarded headers).
 * A number configures how many proxy hops to trust; `true`/`false` set it explicitly.
 */
function trustProxyFromEnv(raw: string | undefined): number | boolean {
  const value = raw?.trim();
  if (value === undefined || value === "" || value.toLowerCase() === "false") return false;
  if (value.toLowerCase() === "true") return true;
  const hops = Number(value);
  if (Number.isInteger(hops) && hops >= 0) return hops;
  return false;
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const port = Number(env.PORT ?? 4000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT value: ${env.PORT}`);
  }

  // A leftover placeholder from .env.example must not be treated as a real token.
  const rawToken = env.GITHUB_TOKEN?.trim();
  const githubToken = rawToken && rawToken !== "your_github_token_here" ? rawToken : undefined;

  const reposDirSetting = env.REPOS_TMP_DIR?.trim() || ".tmp/repos";

  // Ignore the leftover placeholder from .env.example.
  const rawGeminiKey = env.GEMINI_API_KEY?.trim();
  const geminiApiKey =
    rawGeminiKey && rawGeminiKey !== "your_gemini_api_key_here" ? rawGeminiKey : undefined;

  return {
    nodeEnv: env.NODE_ENV ?? "development",
    port,
    webOrigin: env.WEB_ORIGIN ?? "http://localhost:5173",
    reposDir: resolve(REPO_ROOT, reposDirSetting),
    sessionTtlMs: numberFromEnv(env.SESSION_TTL_MINUTES, 30) * 60 * 1000,
    githubToken,
    limits: {
      maxDownloadBytes: numberFromEnv(env.REPO_MAX_DOWNLOAD_MB, 50) * 1024 * 1024,
      maxFileBytes: numberFromEnv(env.REPO_MAX_FILE_MB, 2) * 1024 * 1024,
      maxFiles: numberFromEnv(env.REPO_MAX_FILES, 5000),
      downloadTimeoutMs: numberFromEnv(env.REPO_DOWNLOAD_TIMEOUT_MS, 30_000),
    },
    gemini: {
      apiKey: geminiApiKey,
      model: env.GEMINI_MODEL?.trim() || "gemini-3.5-flash-lite",
      timeoutMs: numberFromEnv(env.GEMINI_TIMEOUT_MS, 30_000),
    },
    rateLimit: {
      windowMs: numberFromEnv(env.RATE_LIMIT_WINDOW_MS, 60_000),
      connectMax: numberFromEnv(env.RATE_LIMIT_CONNECT_MAX, 10),
      browseMax: numberFromEnv(env.RATE_LIMIT_BROWSE_MAX, 120),
    },
    trustProxy: trustProxyFromEnv(env.TRUST_PROXY),
  };
}
