import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { create } from "tar";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createRepoService, type RepoService } from "../src/services/githubService.js";
import type { ApiConfig } from "../src/utils/env.js";

const WRAPPER = "owner-myrepo-abc123";

/** Build a gzipped tarball in memory that mimics GitHub's tarball layout. */
async function makeTarball(): Promise<Buffer> {
  const fixture = await mkdtemp(join(tmpdir(), "repopilot-fixture-"));
  const root = join(fixture, WRAPPER);
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "node_modules", "left-pad"), { recursive: true });
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "README.md"), "# myrepo\n");
  await writeFile(join(root, "src", "index.ts"), "export const hi = 1;\n");
  await writeFile(join(root, ".env"), "SECRET=should-not-be-extracted\n");
  await writeFile(join(root, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  await writeFile(join(root, "dist", "bundle.js"), "console.log(1);\n");

  const chunks: Buffer[] = [];
  for await (const chunk of create({ gzip: true, cwd: fixture }, [WRAPPER]) as AsyncIterable<Buffer>) {
    chunks.push(Buffer.from(chunk));
  }
  await rm(fixture, { recursive: true, force: true });
  return Buffer.concat(chunks);
}

interface MockOptions {
  metadataStatus?: number;
  metadata?: Record<string, unknown>;
  tarball?: Buffer;
}

function makeFetchMock(options: MockOptions): typeof fetch {
  const metadata = {
    name: "myrepo",
    full_name: "owner/myrepo",
    private: false,
    html_url: "https://github.com/owner/myrepo",
    description: "Test repo",
    default_branch: "main",
    size: 10,
    ...options.metadata,
  };

  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/tarball/")) {
      if (!options.tarball) return new Response(null, { status: 404 });
      return new Response(Readable.toWeb(Readable.from(options.tarball)) as never, { status: 200 });
    }
    return new Response(JSON.stringify(metadata), {
      status: options.metadataStatus ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

let reposDir: string;
let service: RepoService;
let tarball: Buffer;

beforeEach(async () => {
  reposDir = await mkdtemp(join(tmpdir(), "repopilot-repos-"));
  tarball = await makeTarball();
});

afterEach(async () => {
  service?.shutdown();
  await rm(reposDir, { recursive: true, force: true });
});

function buildConfig(overrides: Partial<ApiConfig["limits"]> = {}): ApiConfig {
  return {
    nodeEnv: "test",
    port: 4000,
    webOrigin: "http://localhost:5173",
    reposDir,
    sessionTtlMs: 30 * 60 * 1000,
    githubToken: undefined,
    gemini: { apiKey: undefined, model: "gemini-2.5-flash", timeoutMs: 30_000 },
    rateLimit: { windowMs: 60_000, connectMax: 10, browseMax: 120 },
    trustProxy: false,
    limits: {
      maxDownloadBytes: 50 * 1024 * 1024,
      maxFileBytes: 2 * 1024 * 1024,
      maxFiles: 5000,
      downloadTimeoutMs: 10_000,
      ...overrides,
    },
  };
}

function appFor(fetchFn: typeof fetch, config = buildConfig()) {
  service = createRepoService(config, { fetchFn });
  return { app: createApp({ webOrigin: config.webOrigin, repoService: service }), config };
}

describe("POST /api/repos - validation", () => {
  it("rejects a non-string url with 400", async () => {
    const { app } = appFor(makeFetchMock({ tarball }));
    const res = await request(app).post("/api/repos").send({ url: 123 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it("rejects an invalid GitHub url with 400", async () => {
    const { app } = appFor(makeFetchMock({ tarball }));
    const res = await request(app).post("/api/repos").send({ url: "https://gitlab.com/a/b" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/repos - success", () => {
  it("connects a repo, extracts only safe files, and hides server paths", async () => {
    const { app } = appFor(makeFetchMock({ tarball }));
    const res = await request(app)
      .post("/api/repos")
      .send({ url: "https://github.com/owner/myrepo" });

    expect(res.status).toBe(201);
    expect(res.body.repository).toMatchObject({
      owner: "owner",
      name: "myrepo",
      fullName: "owner/myrepo",
      defaultBranch: "main",
      private: false,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/token|Authorization|Bearer/i);
    expect(res.body.fileCount).toBe(2); // README.md + src/index.ts
    expect(res.body.sessionId).toBeTruthy();
    expect(res.body.expiresAt).toBeTruthy();
    // The response must not leak filesystem paths.
    expect(JSON.stringify(res.body)).not.toContain(reposDir);

    // The extracted files exclude secrets, deps, and build output.
    const session = service.get(res.body.sessionId)!;
    const top = await readdir(session.filesDir);
    expect(top.sort()).toEqual(["README.md", "src"]);
  });
});

describe("POST /api/repos - error handling and cleanup", () => {
  it("returns 404 and leaves no workspace when the repo is not found", async () => {
    const { app } = appFor(makeFetchMock({ metadataStatus: 404 }));
    const res = await request(app).post("/api/repos").send({ url: "https://github.com/owner/ghost" });
    expect(res.status).toBe(404);
    expect(await readdir(reposDir)).toHaveLength(0);
  });

  it("rejects a private repository without a token with 403", async () => {
    const { app } = appFor(makeFetchMock({ metadata: { private: true } }));
    const res = await request(app).post("/api/repos").send({ url: "https://github.com/owner/secret" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/private/i);
    expect(await readdir(reposDir)).toHaveLength(0);
  });

  it("rejects repositories that exceed the size limit (metadata) with 413", async () => {
    const config = buildConfig({ maxDownloadBytes: 1024 * 1024 }); // 1 MB => 1024 KB
    const { app } = appFor(makeFetchMock({ metadata: { size: 5000 }, tarball }), config);
    const res = await request(app).post("/api/repos").send({ url: "https://github.com/owner/huge" });
    expect(res.status).toBe(413);
    expect(await readdir(reposDir)).toHaveLength(0);
  });

  it("rejects when the download stream exceeds the byte cap with 413", async () => {
    // Pass metadata size so the early check succeeds, then trip the stream limiter.
    const config = buildConfig({ maxDownloadBytes: 10 });
    const { app } = appFor(makeFetchMock({ metadata: { size: 0 }, tarball }), config);
    const res = await request(app).post("/api/repos").send({ url: "https://github.com/owner/stream" });
    expect(res.status).toBe(413);
    expect(await readdir(reposDir)).toHaveLength(0);
  });
});

describe("GET/DELETE /api/repos/:id - lifecycle", () => {
  it("reads then deletes a session and cleans up its files", async () => {
    const { app } = appFor(makeFetchMock({ tarball }));
    const created = await request(app)
      .post("/api/repos")
      .send({ url: "https://github.com/owner/myrepo" });
    const id = created.body.sessionId as string;

    const read = await request(app).get(`/api/repos/${id}`);
    expect(read.status).toBe(200);
    expect(read.body.sessionId).toBe(id);

    const del = await request(app).delete(`/api/repos/${id}`);
    expect(del.status).toBe(204);

    const readAgain = await request(app).get(`/api/repos/${id}`);
    expect(readAgain.status).toBe(404);
    expect(await readdir(reposDir)).toHaveLength(0);
  });
});

describe("sweepOrphans - cleanup after restart", () => {
  it("removes untracked repository directories", async () => {
    await mkdir(join(reposDir, "leftover-session"), { recursive: true });
    service = createRepoService(buildConfig(), { fetchFn: makeFetchMock({ tarball }) });

    const removed = await service.sweepOrphans();
    expect(removed).toBe(1);
    expect(await readdir(reposDir)).toHaveLength(0);
  });
});
