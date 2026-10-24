import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { create } from "tar";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createAiService } from "../src/services/aiService.js";
import type { GenerateFn, GenerateInput, RawAnswer } from "../src/services/geminiClient.js";
import { createRepoService, type RepoService } from "../src/services/githubService.js";
import { createMcpClient, type McpClient } from "../src/services/mcpClient.js";
import type { ApiConfig } from "../src/utils/env.js";
import { RepoError } from "../src/utils/RepoError.js";

const WRAPPER = "owner-demo-abc123";
const SECRET_VALUE = "TOPSECRET_VALUE_12345";

async function makeTarball(): Promise<Buffer> {
  const fixture = await mkdtemp(join(tmpdir(), "repopilot-fixture-"));
  const root = join(fixture, WRAPPER);
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(root, "README.md"), "# demo\nThe widget renders things.\n");
  await writeFile(join(root, "src", "index.ts"), "export const widget = 1; // findme\n");
  // A secret file whose contents must never be extracted or reach the AI prompt.
  await writeFile(join(root, ".env"), `API_SECRET=${SECRET_VALUE}\n`);
  await writeFile(join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");

  const chunks: Buffer[] = [];
  for await (const chunk of create({ gzip: true, cwd: fixture }, [WRAPPER]) as AsyncIterable<Buffer>) {
    chunks.push(Buffer.from(chunk));
  }
  await rm(fixture, { recursive: true, force: true });
  return Buffer.concat(chunks);
}

function fetchMock(tarball: Buffer): typeof fetch {
  const metadata = {
    name: "demo",
    full_name: "owner/demo",
    private: false,
    html_url: "https://github.com/owner/demo",
    description: "Demo repo",
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

function buildConfig(reposDir: string): ApiConfig {
  return {
    nodeEnv: "test",
    port: 4000,
    webOrigin: "http://localhost:5173",
    reposDir,
    sessionTtlMs: 30 * 60 * 1000,
    githubToken: undefined,
    gemini: { apiKey: "test-key", model: "gemini-test", timeoutMs: 5000 },
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

let reposDir: string;
let service: RepoService;
let mcp: McpClient;

// Capture what the "model" was asked, and control what it returns.
let captured: GenerateInput | undefined;
let generateImpl: GenerateFn;
const generate: GenerateFn = (input) => generateImpl(input);

beforeEach(async () => {
  reposDir = await mkdtemp(join(tmpdir(), "repopilot-repos-"));
  const config = buildConfig(reposDir);
  service = createRepoService(config, { fetchFn: fetchMock(await makeTarball()) });
  mcp = createMcpClient({ reposDir, nodeEnv: "test" });
  captured = undefined;
  generateImpl = async (input): Promise<RawAnswer> => {
    captured = input;
    return {
      answer: "The widget renders things.",
      // Includes a real retrieved path, a secret path, and an invented path.
      sources: [{ path: "src/index.ts" }, { path: ".env" }, { path: "invented/nope.ts" }],
    };
  };
});

afterEach(async () => {
  await mcp.close();
  service.shutdown();
  await rm(reposDir, { recursive: true, force: true });
});

function appWithAi(): ReturnType<typeof createApp> {
  const ai = createAiService(buildConfig(reposDir).gemini, { mcp, generate });
  return createApp({ webOrigin: "http://localhost:5173", repoService: service, mcpClient: mcp, aiService: ai });
}

function appWithoutAiKey(): ReturnType<typeof createApp> {
  // No key and no injected generate => AI disabled.
  const ai = createAiService({ apiKey: undefined, model: "m", timeoutMs: 5000 }, { mcp });
  return createApp({ webOrigin: "http://localhost:5173", repoService: service, mcpClient: mcp, aiService: ai });
}

async function connect(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await request(app).post("/api/repos").send({ url: "https://github.com/owner/demo" });
  expect(res.status).toBe(201);
  return res.body.sessionId as string;
}

describe("end-to-end user journey (real MCP child + mocked GitHub + mocked Gemini)", () => {
  it(
    "connects, browses, searches, and answers with only grounded sources",
    async () => {
      const app = appWithAi();
      const id = await connect(app);

      // Browse: secret/dep files are excluded from the listing.
      const list = await request(app).get(`/api/repos/${id}/files`);
      expect(list.status).toBe(200);
      const paths = (list.body.entries as { path: string }[]).map((e) => e.path);
      expect(paths).toContain("README.md");
      expect(paths).toContain("src/index.ts");
      expect(paths).not.toContain(".env");
      expect(paths.some((p) => p.startsWith("node_modules"))).toBe(false);

      // Open a file and search.
      const file = await request(app).get(`/api/repos/${id}/file`).query({ path: "src/index.ts" });
      expect(file.status).toBe(200);
      expect(file.body.content).toContain("export const widget");
      const search = await request(app).get(`/api/repos/${id}/search`).query({ q: "findme" });
      expect(search.status).toBe(200);
      expect(search.body.matches).toHaveLength(1);

      // Ask a question; context is gathered through MCP.
      const ask = await request(app).post(`/api/repos/${id}/ask`).send({ question: "How does the widget work?" });
      expect(ask.status).toBe(200);
      expect(ask.body.answer).toBeTruthy();

      // SECURITY: the prompt sent to the model must include repo context but NEVER the secret.
      expect(captured?.prompt).toContain("widget");
      expect(captured?.prompt).not.toContain(SECRET_VALUE);

      // SECURITY: invented and secret-file citations are dropped; only retrieved paths survive.
      expect(ask.body.sources).toEqual([{ path: "src/index.ts" }]);
      expect(ask.body.grounded).toBe(true);
      expect(ask.body.contextFiles).not.toContain(".env");
    },
    30_000,
  );

  it(
    "keeps browsing working when no Gemini key is configured, but blocks Ask with 503",
    async () => {
      const app = appWithoutAiKey();
      const id = await connect(app);

      const list = await request(app).get(`/api/repos/${id}/files`);
      expect(list.status).toBe(200);

      const ask = await request(app).post(`/api/repos/${id}/ask`).send({ question: "anything?" });
      expect(ask.status).toBe(503);
    },
    30_000,
  );

  it(
    "maps provider failures to 502 without leaking internals",
    async () => {
      generateImpl = async () => {
        throw new RepoError(502, "The AI provider returned an error. Please try again.");
      };
      const app = appWithAi();
      const id = await connect(app);
      const ask = await request(app).post(`/api/repos/${id}/ask`).send({ question: "How does the widget work?" });
      expect(ask.status).toBe(502);
      expect(JSON.stringify(ask.body)).not.toContain(reposDir);
    },
    30_000,
  );

  it(
    "blocks file access and AI once a session is deleted/expired, and cleans up files",
    async () => {
      const app = appWithAi();
      const id = await connect(app);

      const del = await request(app).delete(`/api/repos/${id}`);
      expect(del.status).toBe(204);
      expect(await readdir(reposDir)).toHaveLength(0);

      const file = await request(app).get(`/api/repos/${id}/file`).query({ path: "src/index.ts" });
      expect(file.status).toBe(404);

      const ask = await request(app).post(`/api/repos/${id}/ask`).send({ question: "How does the widget work?" });
      expect(ask.status).toBe(404);
    },
    30_000,
  );

  it("rejects invalid repository URLs before any network/filesystem work", async () => {
    const app = appWithAi();
    const res = await request(app).post("/api/repos").send({ url: "https://gitlab.com/a/b" });
    expect(res.status).toBe(400);
    expect(await readdir(reposDir)).toHaveLength(0);
  });
});
