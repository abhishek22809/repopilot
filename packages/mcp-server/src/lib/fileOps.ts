import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { McpConfig } from "../config.js";
import { ToolError } from "./errors.js";
import {
  isProbablyBinary,
  resolveSessionDir,
  resolveWithin,
  toPosix,
  walkFiles,
  type WalkEntry,
} from "./workspace.js";

export interface ListResult {
  directory: string;
  count: number;
  truncated: boolean;
  entries: WalkEntry[];
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchResult {
  query: string;
  count: number;
  truncated: boolean;
  matches: SearchMatch[];
}

export interface ReadResult {
  path: string;
  size: number;
  lineCount: number;
  content: string;
}

export async function listProjectFiles(
  config: McpConfig,
  sessionId: unknown,
  dirPath?: string,
): Promise<ListResult> {
  const baseDir = await resolveSessionDir(config.reposDir, sessionId);

  let startRel = "";
  if (dirPath !== undefined && dirPath.trim() !== "" && dirPath.trim() !== ".") {
    const target = await resolveWithin(baseDir, dirPath);
    const info = await stat(target);
    if (!info.isDirectory()) {
      throw new ToolError(400, "Path is not a directory.");
    }
    startRel = toPosix(dirPath);
  }

  const { entries, truncated } = await walkFiles(baseDir, startRel, config.limits.maxListEntries);
  entries.sort((a, b) => a.path.localeCompare(b.path));

  return { directory: startRel === "" ? "." : startRel, count: entries.length, truncated, entries };
}

export async function searchProjectCode(
  config: McpConfig,
  sessionId: unknown,
  query: unknown,
  extension?: string,
): Promise<SearchResult> {
  const baseDir = await resolveSessionDir(config.reposDir, sessionId);

  if (typeof query !== "string" || query.trim() === "") {
    throw new ToolError(400, "A non-empty search query is required.");
  }
  const needle = query.toLowerCase();
  const ext =
    extension && extension.trim() !== ""
      ? `.${extension.trim().replace(/^\./, "").toLowerCase()}`
      : undefined;

  const { entries } = await walkFiles(baseDir, "", config.limits.maxListEntries);
  const matches: SearchMatch[] = [];

  for (const entry of entries) {
    if (entry.type !== "file") continue;
    if (ext && !entry.path.toLowerCase().endsWith(ext)) continue;

    const abs = join(baseDir, entry.path);
    let info;
    try {
      info = await stat(abs);
    } catch {
      continue;
    }
    if (info.size > config.limits.maxFileBytes) continue;

    let buffer;
    try {
      buffer = await readFile(abs);
    } catch {
      continue;
    }
    if (isProbablyBinary(buffer)) continue;

    const lines = buffer.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i]!.toLowerCase().includes(needle)) {
        matches.push({
          path: entry.path,
          line: i + 1,
          text: lines[i]!.slice(0, config.limits.maxLineLength),
        });
        if (matches.length >= config.limits.maxSearchResults) {
          return { query, count: matches.length, truncated: true, matches };
        }
      }
    }
  }

  return { query, count: matches.length, truncated: false, matches };
}

export async function readProjectFile(
  config: McpConfig,
  sessionId: unknown,
  filePath: unknown,
): Promise<ReadResult> {
  const baseDir = await resolveSessionDir(config.reposDir, sessionId);
  const target = await resolveWithin(baseDir, filePath);

  const info = await stat(target);
  if (!info.isFile()) {
    throw new ToolError(400, "Path is not a file.");
  }
  if (info.size > config.limits.maxFileBytes) {
    throw new ToolError(413, "File is too large to display.");
  }

  const buffer = await readFile(target);
  if (isProbablyBinary(buffer)) {
    throw new ToolError(415, "Cannot display a binary file.");
  }

  const content = buffer.toString("utf8");
  const lineCount = content === "" ? 0 : content.split(/\r?\n/).length;

  return { path: toPosix(filePath as string), size: info.size, lineCount, content };
}
