import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { create } from "tar";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createRepoService, type RepoService } from "../src/services/githubService.js";
import { createMcpClient, type McpClient } from "../src/services/mcpClient.js";
import type { ApiConfig } from "../src/utils/env.js";

const WRAPPER = "owner-myrepo-abc123";

async function makeTarball(): Promise<Buffer> {
  const fixture = await mkdtemp(join(tmpdir(), "repopilot-fixture-"));
  const root = join(fixture, WRAPPER);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "README.md"), "# myrepo\nwelcome\n");
  await writeFile(join(root, "src", "index.ts"), "export const hi = 1;\n// findme marker\n");
  await writeFile(join(root, ".env"), "SECRET=nope\n");

  const chunks: Buffer[] = [];
  for await (const chunk of create({ gzip: true, cwd: fixture }, [WRAPPER]) as AsyncIterable<Buffer>) {
    chunks.push(Buffer.from(chunk));
  }
  await rm(fixture, { recursive: true, force: true });
  return Buffer.concat(chunks);
}

function fetchMock(tarball: Buffer): typeof fetch {
  const metadata = {
    name: "myrepo",
    full_name: "owner/myrepo",
    private: false,
    html_url: "https://github.com/owner/myrepo",
    description: "Test repo",
    default_branch: "main",
    size: 5,
  };
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/tarball/")) {
      return new Response(Readable.toWeb(Readable.from(tarball)) as never, { status: 200 });
    }
    return new Response(JSON.stringify(metadata), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

let reposDir: string;
let service: RepoService;
let mcp: McpClient;

function buildConfig(): ApiConfig {
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
    },
  };
}

beforeEach(async () => {
  reposDir = await mkdtemp(join(tmpdir(), "repopilot-repos-"));
  const config = buildConfig();
  service = createRepoService(config, { fetchFn: fetchMock(await makeTarball()) });
  mcp = createMcpClient({ reposDir, nodeEnv: "test" });
});

afterEach(async () => {
  await mcp.close();
  service.shutdown();
  await rm(reposDir, { recursive: true, force: true });
});

async function connectRepo(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await request(app).post("/api/repos").send({ url: "https://github.com/owner/myrepo" });
  expect(res.status).toBe(201);
  return res.body.sessionId as string;
}

describe("backend <-> MCP child process integration", () => {
  it(
    "lists files, reads a file, and searches via the real MCP server",
    async () => {
      const app = createApp({ webOrigin: "http://localhost:5173", repoService: service, mcpClient: mcp });
      const id = await connectRepo(app);

      const list = await request(app).get(`/api/repos/${id}/files`);
      expect(list.status).toBe(200);
      const paths = (list.body.entries as { path: string }[]).map((e) => e.path);
      expect(paths).toContain("README.md");
      expect(paths).toContain("src/index.ts");
      expect(paths).not.toContain(".env");

      const file = await request(app).get(`/api/repos/${id}/file`).query({ path: "src/index.ts" });
      expect(file.status).toBe(200);
      expect(file.body.content).toContain("export const hi");
      expect(file.body.lineCount).toBeGreaterThan(0);

      const search = await request(app).get(`/api/repos/${id}/search`).query({ q: "findme" });
      expect(search.status).toBe(200);
      expect(search.body.matches).toHaveLength(1);
      expect(search.body.matches[0]).toMatchObject({ path: "src/index.ts" });
    },
    30_000,
  );

  it(
    "rejects traversal and unknown sessions",
    async () => {
      const app = createApp({ webOrigin: "http://localhost:5173", repoService: service, mcpClient: mcp });
      const id = await connectRepo(app);

      const traversal = await request(app).get(`/api/repos/${id}/file`).query({ path: "../../etc/passwd" });
      expect(traversal.status).toBe(400);

      const unknown = await request(app).get(`/api/repos/${randomUUID()}/files`);
      expect(unknown.status).toBe(404);
    },
    30_000,
  );
});
