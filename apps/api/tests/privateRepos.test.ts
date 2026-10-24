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
import { normalizeGitHubToken } from "../src/utils/githubToken.js";

const WRAPPER = "owner-secret-abc123";
const TEST_TOKEN = "ghp_testtoken_abcdefghijklmnopqrstuvwxyz";
const SERVER_TOKEN = "ghp_servertoken_should_not_open_private";

async function makeTarball(): Promise<Buffer> {
  const fixture = await mkdtemp(join(tmpdir(), "repopilot-fixture-"));
  const root = join(fixture, WRAPPER);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "README.md"), "# secret\n");
  const chunks: Buffer[] = [];
  for await (const chunk of create({ gzip: true, cwd: fixture }, [WRAPPER]) as AsyncIterable<Buffer>) {
    chunks.push(Buffer.from(chunk));
  }
  await rm(fixture, { recursive: true, force: true });
  return Buffer.concat(chunks);
}

interface RecordedCall {
  url: string;
  authorization: string | undefined;
}

interface MockOptions {
  metadataStatus?: number;
  metadata?: Record<string, unknown>;
  tarballStatus?: number;
  tarball?: Buffer;
  requireAuth?: boolean;
}

function makeFetchMock(options: MockOptions, calls: RecordedCall[]): typeof fetch {
  const metadata = {
    name: "secret",
    full_name: "owner/secret",
    private: true,
    html_url: "https://github.com/owner/secret",
    description: "Private repo",
    default_branch: "main",
    size: 4,
    ...options.metadata,
  };

  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const rawHeaders = init?.headers;
    let authorization: string | undefined;
    if (rawHeaders && typeof rawHeaders === "object" && !Array.isArray(rawHeaders)) {
      const record = rawHeaders as Record<string, string>;
      authorization = record.Authorization ?? record.authorization;
    }
    calls.push({ url, authorization });

    if (options.requireAuth && !authorization) {
      return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
    }
    if (options.requireAuth && authorization !== `Bearer ${TEST_TOKEN}`) {
      return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
    }

    if (url.includes("/tarball/")) {
      if (!options.tarball) return new Response(null, { status: options.tarballStatus ?? 404 });
      if (options.tarballStatus && options.tarballStatus !== 200) {
        return new Response(null, { status: options.tarballStatus });
      }
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

function buildConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    nodeEnv: "test",
    port: 4000,
    webOrigin: "http://localhost:5173",
    reposDir,
    sessionTtlMs: 30 * 60 * 1000,
    githubToken: undefined,
    gemini: { apiKey: undefined, model: "gemini-3.5-flash-lite", timeoutMs: 30_000 },
    rateLimit: { windowMs: 60_000, connectMax: 10, browseMax: 120 },
    trustProxy: false,
    limits: {
      maxDownloadBytes: 50 * 1024 * 1024,
      maxFileBytes: 2 * 1024 * 1024,
      maxFiles: 5000,
      downloadTimeoutMs: 10_000,
    },
    ...overrides,
  };
}

function appFor(fetchFn: typeof fetch, config = buildConfig()) {
  service = createRepoService(config, { fetchFn });
  return createApp({ webOrigin: config.webOrigin, repoService: service });
}

function expectNoTokenLeak(body: unknown): void {
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain(TEST_TOKEN);
  expect(serialized).not.toContain(SERVER_TOKEN);
  expect(serialized).not.toMatch(/Bearer /);
}

describe("normalizeGitHubToken", () => {
  it("treats empty values as absent", () => {
    expect(normalizeGitHubToken(undefined)).toBeUndefined();
    expect(normalizeGitHubToken("")).toBeUndefined();
    expect(normalizeGitHubToken("   ")).toBeUndefined();
  });

  it("rejects malformed tokens without echoing them", () => {
    expect(() => normalizeGitHubToken("short")).toThrow(/invalid/i);
    expect(() => normalizeGitHubToken("not a token because spaces!!!!!")).toThrow(/invalid/i);
    try {
      normalizeGitHubToken("not a token because spaces!!!!!");
    } catch (error) {
      expect(String(error)).not.toContain("not a token because spaces");
    }
  });
});

describe("POST /api/repos - private repositories", () => {
  it("connects an authorized private repository using the request token", async () => {
    const calls: RecordedCall[] = [];
    const app = appFor(makeFetchMock({ tarball, requireAuth: true }, calls));

    const res = await request(app)
      .post("/api/repos")
      .send({ url: "https://github.com/owner/secret", token: TEST_TOKEN });

    expect(res.status).toBe(201);
    expect(res.body.repository).toMatchObject({
      owner: "owner",
      name: "secret",
      private: true,
    });
    expectNoTokenLeak(res.body);

    const session = service.get(res.body.sessionId as string);
    expect(session).toBeTruthy();
    expect(JSON.stringify(session)).not.toContain(TEST_TOKEN);
    expect(session?.repository.private).toBe(true);

    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.every((c) => c.authorization === `Bearer ${TEST_TOKEN}`)).toBe(true);
    expect(await readdir(session!.filesDir)).toContain("README.md");
  });

  it("still connects a public repository without a token", async () => {
    const calls: RecordedCall[] = [];
    const app = appFor(
      makeFetchMock({ tarball, metadata: { private: false, name: "myrepo", full_name: "owner/myrepo" } }, calls),
    );

    const res = await request(app).post("/api/repos").send({ url: "https://github.com/owner/myrepo" });
    expect(res.status).toBe(201);
    expect(res.body.repository.private).toBe(false);
    expect(calls.every((c) => c.authorization === undefined)).toBe(true);
    expectNoTokenLeak(res.body);
  });

  it("does not use the server GITHUB_TOKEN to open a private repository", async () => {
    const calls: RecordedCall[] = [];
    const app = appFor(
      makeFetchMock({ metadata: { private: true } }, calls),
      buildConfig({ githubToken: SERVER_TOKEN }),
    );

    const res = await request(app).post("/api/repos").send({ url: "https://github.com/owner/secret" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/private/i);
    expectNoTokenLeak(res.body);
    expect(await readdir(reposDir)).toHaveLength(0);
    // Metadata was fetched (possibly with the server token for public rate limits),
    // but the private repo is still rejected without a request token.
    expect(calls.some((c) => c.url.includes("/tarball/"))).toBe(false);
  });

  it("returns 401 for an invalid token without leaking it", async () => {
    const calls: RecordedCall[] = [];
    const app = appFor(makeFetchMock({ metadataStatus: 401, requireAuth: true }, calls));

    const res = await request(app)
      .post("/api/repos")
      .send({ url: "https://github.com/owner/secret", token: TEST_TOKEN });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/token/i);
    expectNoTokenLeak(res.body);
    expect(await readdir(reposDir)).toHaveLength(0);
  });

  it("returns 403 when the token lacks permission", async () => {
    const calls: RecordedCall[] = [];
    const app = appFor(makeFetchMock({ metadataStatus: 403 }, calls));

    const res = await request(app)
      .post("/api/repos")
      .send({ url: "https://github.com/owner/secret", token: TEST_TOKEN });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/permission|Contents: Read/i);
    expectNoTokenLeak(res.body);
  });

  it("returns 404 when the token cannot see the repository", async () => {
    const app = appFor(makeFetchMock({ metadataStatus: 404 }, []));
    const res = await request(app)
      .post("/api/repos")
      .send({ url: "https://github.com/owner/ghost", token: TEST_TOKEN });
    expect(res.status).toBe(404);
    expectNoTokenLeak(res.body);
    expect(await readdir(reposDir)).toHaveLength(0);
  });

  it("rejects a malformed token before calling GitHub", async () => {
    const calls: RecordedCall[] = [];
    const app = appFor(makeFetchMock({ tarball }, calls));
    const res = await request(app)
      .post("/api/repos")
      .send({ url: "https://github.com/owner/secret", token: "nope" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
    expect(calls).toHaveLength(0);
  });
});
