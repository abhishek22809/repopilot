import { RepoError } from "./RepoError.js";

const MIN_TOKEN_CHARS = 20;
const MAX_TOKEN_CHARS = 512;
const TOKEN_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Normalize an optional per-request GitHub token.
 *
 * Empty / missing → `undefined` (public-repo flow). Rejects values that are not
 * a single token string so we never interpolate user input into a header blindly.
 * Does not log or return the token.
 */
export function normalizeGitHubToken(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new RepoError(400, "If provided, 'token' must be a string.");
  }
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (
    trimmed.length < MIN_TOKEN_CHARS ||
    trimmed.length > MAX_TOKEN_CHARS ||
    !TOKEN_PATTERN.test(trimmed)
  ) {
    throw new RepoError(
      400,
      "That GitHub token looks invalid. Use a fine-grained personal access token with Contents: Read for this repository only.",
    );
  }
  return trimmed;
}
