export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

const ALLOWED_HOSTS = new Set(["github.com", "www.github.com"]);

// GitHub owner and repository names: letters, digits, '.', '_', '-'.
const NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_])?$/;

function isValidName(name: string): boolean {
  if (name.length === 0 || name.length > 100) return false;
  if (name === "." || name === "..") return false;
  return NAME_PATTERN.test(name);
}

/**
 * Parse and validate a public GitHub repository URL.
 *
 * Accepts only `https://github.com/<owner>/<repo>` (optionally `www.`, a trailing
 * `.git`, a trailing slash, or deeper paths like `/tree/main`). Everything else —
 * other hosts, non-HTTPS schemes, SSH URLs, local addresses — returns `null`.
 */
export function parseGitHubRepoUrl(input: string): GitHubRepoRef | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed === "" || trimmed.length > 2048) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "" || url.port !== "") return null;
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) return null;

  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  if (segments.length < 2) return null;

  const owner = segments[0]!;
  let repo = segments[1]!;
  if (repo.toLowerCase().endsWith(".git")) {
    repo = repo.slice(0, -4);
  }

  if (!isValidName(owner) || !isValidName(repo)) return null;

  return { owner, repo };
}
