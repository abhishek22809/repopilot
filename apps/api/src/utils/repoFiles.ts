// Decides which archive entries are safe and useful to extract. Kept pure so it
// can be unit-tested without touching the filesystem or the network.

/** Directory names that are never extracted (VCS metadata, deps, build output). */
const EXCLUDED_DIRS = new Set([
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".output",
  "coverage",
  ".cache",
  ".turbo",
  ".parcel-cache",
  ".vercel",
  ".netlify",
  "__pycache__",
  ".venv",
  "venv",
]);

/** Exact file names that may contain secrets and are never extracted. */
const EXCLUDED_FILES = new Set([
  ".npmrc",
  ".netrc",
  ".git-credentials",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);

/** Archive entry kinds we accept. Symlinks and hardlinks are rejected outright. */
export type EntryKind = "File" | "Directory" | "SymbolicLink" | "Link" | "Other";

function isSecretFile(name: string): boolean {
  if (EXCLUDED_FILES.has(name)) return true;
  // .env, .env.local, .env.production, etc. (but keep .env.example).
  if (name === ".env") return true;
  if (name.startsWith(".env.") && name !== ".env.example" && name !== ".env.sample") return true;
  // Private keys and certificates.
  if (/\.(pem|key|pfx|p12|keystore)$/i.test(name)) return true;
  return false;
}

/**
 * Normalize an archive path (after the top-level folder has been stripped) and
 * decide whether it should be extracted.
 *
 * @param strippedPath path relative to the repository root, e.g. `src/index.ts`
 */
export function shouldExtractEntry(strippedPath: string, kind: EntryKind): boolean {
  // Only regular files and directories. Symlinks/hardlinks are an escape risk.
  if (kind !== "File" && kind !== "Directory") return false;

  const normalized = strippedPath.replaceAll("\\", "/").replace(/\/+$/, "");
  if (normalized === "") return false;

  const segments = normalized.split("/");

  // Defense in depth against path traversal (tar also strips these).
  if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) {
    return false;
  }

  if (segments.some((segment) => EXCLUDED_DIRS.has(segment))) return false;

  if (kind === "File") {
    const fileName = segments[segments.length - 1]!;
    if (isSecretFile(fileName)) return false;
  }

  return true;
}

/** Remove the leading `<owner>-<repo>-<sha>/` folder that GitHub tarballs wrap files in. */
export function stripTopLevelDir(archivePath: string): string {
  const normalized = archivePath.replaceAll("\\", "/");
  const slashIndex = normalized.indexOf("/");
  return slashIndex === -1 ? "" : normalized.slice(slashIndex + 1);
}
