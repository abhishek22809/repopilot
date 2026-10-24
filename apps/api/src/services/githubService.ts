import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extract, type ReadEntry } from "tar";
import type { ApiConfig } from "../utils/env.js";
import { RepoError } from "../utils/RepoError.js";
import { shouldExtractEntry, stripTopLevelDir, type EntryKind } from "../utils/repoFiles.js";
import { parseGitHubRepoUrl } from "../utils/githubUrl.js";
import { SessionStore, type RepoSession } from "./sessionStore.js";

const GITHUB_API = "https://api.github.com";

interface GitHubRepoMetadata {
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  description: string | null;
  default_branch: string;
  /** Size in kilobytes, as reported by the GitHub API. */
  size: number;
}

type FetchFn = typeof fetch;

export interface RepoServiceDeps {
  fetchFn?: FetchFn;
  sessionStore?: SessionStore;
}

export interface RepoService {
  /**
   * Connect a repository. `requestToken` is a per-request PAT used only for this
   * GitHub download; it is never stored on the session.
   */
  connect(url: string, requestToken?: string): Promise<RepoSession>;
  get(id: string): RepoSession | undefined;
  disconnect(id: string): Promise<boolean>;
  sweepOrphans(): Promise<number>;
  shutdown(): void;
}

function githubHeaders(
  config: ApiConfig,
  accept: string,
  requestToken?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: accept,
    "User-Agent": "RepoPilot",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  // Per-request token wins. The server GITHUB_TOKEN is only a public-repo rate-limit
  // helper and is never used to open a private repository.
  const token = requestToken ?? config.githubToken;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function isRateLimited(response: Response): boolean {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  return response.headers.get("x-ratelimit-remaining") === "0";
}

function mapGitHubAccessError(response: Response, requestToken: string | undefined): never {
  if (response.status === 401) {
    throw new RepoError(401, "GitHub rejected this token. Check that it is valid and not expired.");
  }
  if (isRateLimited(response)) {
    throw new RepoError(
      429,
      requestToken
        ? "GitHub API rate limit reached. Please try again later."
        : "GitHub API rate limit reached. Try again later or provide a token.",
    );
  }
  if (response.status === 403) {
    throw new RepoError(
      403,
      requestToken
        ? "This token does not have permission to read that repository. Use a fine-grained token with Contents: Read for this repository only."
        : "GitHub denied this request. Private repositories require a token; public repositories may be rate-limited.",
    );
  }
  if (response.status === 404) {
    throw new RepoError(
      404,
      requestToken
        ? "Repository not found, or this token cannot access it."
        : "Repository not found. It may be private or the URL is incorrect.",
    );
  }
  throw new RepoError(502, "Unexpected response from GitHub.");
}

function mapEntryKind(type: ReadEntry["type"]): EntryKind {
  switch (type) {
    case "File":
    case "OldFile":
    case "ContiguousFile":
      return "File";
    case "Directory":
    case "GNUDumpDir":
      return "Directory";
    case "SymbolicLink":
      return "SymbolicLink";
    case "Link":
      return "Link";
    default:
      return "Other";
  }
}

export function createRepoService(config: ApiConfig, deps: RepoServiceDeps = {}): RepoService {
  const fetchFn: FetchFn = deps.fetchFn ?? fetch;
  const store = deps.sessionStore ?? new SessionStore(config.reposDir, config.sessionTtlMs);

  async function fetchMetadata(
    owner: string,
    repo: string,
    requestToken?: string,
  ): Promise<GitHubRepoMetadata> {
    let response: Response;
    try {
      response = await fetchFn(`${GITHUB_API}/repos/${owner}/${repo}`, {
        headers: githubHeaders(config, "application/vnd.github+json", requestToken),
        signal: AbortSignal.timeout(config.limits.downloadTimeoutMs),
      });
    } catch {
      throw new RepoError(502, "Could not reach GitHub. Check your connection and try again.");
    }

    if (!response.ok) {
      mapGitHubAccessError(response, requestToken);
    }

    const metadata = (await response.json()) as GitHubRepoMetadata;
    if (metadata.private && !requestToken) {
      throw new RepoError(
        403,
        "This repository is private. Provide a fine-grained GitHub token with Contents: Read for this repository only.",
      );
    }

    const maxKb = config.limits.maxDownloadBytes / 1024;
    if (typeof metadata.size === "number" && metadata.size > maxKb) {
      throw new RepoError(413, "Repository is too large to analyze.");
    }

    return metadata;
  }

  async function downloadTarball(
    owner: string,
    repo: string,
    ref: string,
    tarPath: string,
    requestToken?: string,
  ): Promise<void> {
    let response: Response;
    try {
      response = await fetchFn(
        `${GITHUB_API}/repos/${owner}/${repo}/tarball/${encodeURIComponent(ref)}`,
        {
          headers: githubHeaders(config, "application/vnd.github+json", requestToken),
          signal: AbortSignal.timeout(config.limits.downloadTimeoutMs),
        },
      );
    } catch {
      throw new RepoError(504, "Timed out downloading the repository.");
    }

    if (!response.ok || !response.body) {
      if (!response.ok) {
        mapGitHubAccessError(response, requestToken);
      }
      throw new RepoError(502, "Could not download the repository archive from GitHub.");
    }

    let downloaded = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        downloaded += chunk.length;
        if (downloaded > config.limits.maxDownloadBytes) {
          callback(new RepoError(413, "Repository is too large to analyze."));
          return;
        }
        callback(null, chunk);
      },
    });

    await pipeline(Readable.fromWeb(response.body as never), limiter, createWriteStream(tarPath));
  }

  async function extractTarball(tarPath: string, filesDir: string): Promise<number> {
    let fileCount = 0;
    let tooManyFiles = false;

    await extract({
      file: tarPath,
      cwd: filesDir,
      strip: 1,
      preservePaths: false,
      filter: (path, entry) => {
        const relativePath = stripTopLevelDir(path);
        const kind = mapEntryKind("type" in entry ? entry.type : "File");
        if (!shouldExtractEntry(relativePath, kind)) return false;

        if (kind === "File") {
          if ((entry.size ?? 0) > config.limits.maxFileBytes) return false;
          if (fileCount >= config.limits.maxFiles) {
            tooManyFiles = true;
            return false;
          }
          fileCount += 1;
        }
        return true;
      },
    });

    if (tooManyFiles) {
      throw new RepoError(413, "Repository has too many files to analyze.");
    }
    return fileCount;
  }

  async function connect(url: string, requestToken?: string): Promise<RepoSession> {
    const ref = parseGitHubRepoUrl(url);
    if (!ref) {
      throw new RepoError(
        400,
        "Enter a valid GitHub repository URL, e.g. https://github.com/owner/repo.",
      );
    }

    const metadata = await fetchMetadata(ref.owner, ref.repo, requestToken);

    const sessionId = randomUUID();
    const rootDir = join(config.reposDir, sessionId);
    const filesDir = join(rootDir, "files");
    const tarPath = join(rootDir, "repo.tar.gz");

    try {
      await mkdir(filesDir, { recursive: true });
      await downloadTarball(ref.owner, ref.repo, metadata.default_branch, tarPath, requestToken);
      const fileCount = await extractTarball(tarPath, filesDir);
      await rm(tarPath, { force: true });

      return store.add({
        id: sessionId,
        repository: {
          owner: ref.owner,
          name: metadata.name,
          fullName: metadata.full_name,
          defaultBranch: metadata.default_branch,
          htmlUrl: metadata.html_url,
          description: metadata.description,
          private: Boolean(metadata.private),
        },
        fileCount,
        createdAt: Date.now(),
        filesDir,
        rootDir,
      });
    } catch (error) {
      // Clean up partial downloads/extractions on any failure.
      await rm(rootDir, { recursive: true, force: true });
      throw error;
    }
  }

  return {
    connect,
    get: (id) => store.get(id),
    disconnect: (id) => store.delete(id),
    sweepOrphans: () => store.sweepOrphans(),
    shutdown: () => store.shutdown(),
  };
}
