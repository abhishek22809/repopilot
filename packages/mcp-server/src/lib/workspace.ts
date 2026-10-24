import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { ToolError } from "./errors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Directory names that are never listed, searched, or read. */
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

const EXCLUDED_FILES = new Set([
  ".npmrc",
  ".netrc",
  ".git-credentials",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);

export function isSecretFile(name: string): boolean {
  if (EXCLUDED_FILES.has(name)) return true;
  if (name === ".env") return true;
  if (name.startsWith(".env.") && name !== ".env.example" && name !== ".env.sample") return true;
  if (/\.(pem|key|pfx|p12|keystore)$/i.test(name)) return true;
  return false;
}

/** Whether a repo-relative path touches an excluded directory or a secret file. */
export function isExcludedRelPath(relPath: string): boolean {
  const segments = relPath.split(/[\\/]/).filter(Boolean);
  if (segments.some((segment) => EXCLUDED_DIRS.has(segment))) return true;
  const name = segments[segments.length - 1];
  return name !== undefined && isSecretFile(name);
}

/** Convert a path to canonical POSIX form for stable output. */
export function toPosix(relPath: string): string {
  return normalize(relPath).replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * Resolve a sessionId to its absolute, canonical files directory. Throws if the id
 * is malformed (traversal guard) or the workspace no longer exists (expired session).
 */
export async function resolveSessionDir(reposDir: string, sessionId: unknown): Promise<string> {
  if (typeof sessionId !== "string" || !UUID_RE.test(sessionId)) {
    throw new ToolError(400, "Invalid session id.");
  }
  const dir = join(reposDir, sessionId, "files");
  let info;
  try {
    info = await stat(dir);
  } catch {
    throw new ToolError(404, "Session not found or expired.");
  }
  if (!info.isDirectory()) {
    throw new ToolError(404, "Session not found or expired.");
  }
  return realpath(dir);
}

/**
 * Safely resolve a repo-relative path inside `baseRealDir`. Rejects absolute paths,
 * traversal, excluded/secret files, symlinks, and anything that escapes the base
 * (including via symlinked parent directories). Returns the absolute target path.
 */
export async function resolveWithin(baseRealDir: string, relPath: unknown): Promise<string> {
  if (typeof relPath !== "string" || relPath.trim() === "") {
    throw new ToolError(400, "A file path is required.");
  }
  if (relPath.includes("\0")) {
    throw new ToolError(400, "Invalid file path.");
  }
  if (isAbsolute(relPath)) {
    throw new ToolError(400, "Absolute paths are not allowed.");
  }

  const normalized = normalize(relPath);
  if (normalized.split(/[\\/]/).some((segment) => segment === "..")) {
    throw new ToolError(400, "Path traversal is not allowed.");
  }
  if (isExcludedRelPath(normalized)) {
    throw new ToolError(403, "Access to this file is not allowed.");
  }

  const target = join(baseRealDir, normalized);
  const rel = relative(baseRealDir, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new ToolError(400, "Path is outside the repository.");
  }

  let linkInfo;
  try {
    linkInfo = await lstat(target);
  } catch {
    throw new ToolError(404, "File not found.");
  }
  if (linkInfo.isSymbolicLink()) {
    throw new ToolError(403, "Symlinked files are not allowed.");
  }

  // Canonicalize to defend against symlinked parent directories.
  const realTarget = await realpath(target);
  const realRel = relative(baseRealDir, realTarget);
  if (realRel !== "" && (realRel.startsWith("..") || isAbsolute(realRel))) {
    throw new ToolError(403, "Path escapes the repository.");
  }

  return target;
}

export interface WalkEntry {
  path: string;
  type: "file" | "dir";
}

/**
 * Walk the workspace starting at `startRel` (relative to base), skipping excluded
 * directories, secret files, and symlinks. Stops once `limit` entries are collected.
 */
export async function walkFiles(
  baseRealDir: string,
  startRel: string,
  limit: number,
): Promise<{ entries: WalkEntry[]; truncated: boolean }> {
  const entries: WalkEntry[] = [];
  const stack: string[] = [startRel];

  while (stack.length > 0) {
    const rel = stack.pop()!;
    const abs = rel === "" ? baseRealDir : join(baseRealDir, rel);

    let dirents;
    try {
      dirents = await readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));

    for (const dirent of dirents) {
      if (dirent.isSymbolicLink()) continue;
      const childRel = rel === "" ? dirent.name : `${rel}/${dirent.name}`;
      if (isExcludedRelPath(childRel)) continue;

      if (entries.length >= limit) {
        return { entries, truncated: true };
      }

      if (dirent.isDirectory()) {
        entries.push({ path: childRel, type: "dir" });
        stack.push(childRel);
      } else if (dirent.isFile()) {
        entries.push({ path: childRel, type: "file" });
      }
    }
  }

  return { entries, truncated: false };
}

/** Heuristic binary-file detection: a NUL byte in the first 8 KB. */
export function isProbablyBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8000);
  for (let i = 0; i < limit; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

export { sep };
