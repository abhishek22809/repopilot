import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createAiService } from "../src/services/aiService.js";
import type { RepoService } from "../src/services/githubService.js";
import type { McpClient } from "../src/services/mcpClient.js";
import type { RepoSession } from "../src/services/sessionStore.js";
import type { GeminiConfig } from "../src/utils/env.js";

const KNOWN = "11111111-1111-4111-8111-111111111111";
const CONFIG: GeminiConfig = { apiKey: "test-key", model: "gemini-test", timeoutMs: 5000 };

function fakeSession(id: string): RepoSession {
  return {
    id,
    repository: {
      owner: "o",
      name: "r",
      fullName: "o/r",
      defaultBranch: "main",
      htmlUrl: "https://github.com/o/r",
      description: null,
      private: false,
    },
    fileCount: 1,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    filesDir: "/tmp/does-not-matter",
  };
}

const repoService = {
  connect: async () => fakeSession(KNOWN),
  get: (id: string) => (id === KNOWN ? fakeSession(id) : undefined),
  disconnect: async () => true,
  sweepOrphans: async () => 0,
  shutdown: () => {},
} as unknown as RepoService;

const mcp: McpClient = {
  async callTool(name, args) {
    if (name === "search_project_code") return { matches: [{ path: "README.md", line: 1, text: "hi" }] };
    if (name === "list_project_files") return { entries: [{ path: "README.md", type: "file" }] };
    if (name === "read_project_file") return { path: (args as { path: string }).path, lineCount: 1, content: "hi" };
    return {};
  },
  async close() {},
};

function appWithAi(configured = true) {
  const aiService = createAiService(configured ? CONFIG : { ...CONFIG, apiKey: undefined }, {
    mcp,
    generate: configured
      ? async () => ({ answer: "This repo says hi.", sources: [{ path: "README.md" }] })
      : undefined,
  });
  return createApp({ webOrigin: "http://localhost:5173", repoService, mcpClient: mcp, aiService });
}

describe("POST /api/repos/:id/ask", () => {
  it("returns a grounded answer", async () => {
    const res = await request(appWithAi()).post(`/api/repos/${KNOWN}/ask`).send({ question: "what does it say?" });
    expect(res.status).toBe(200);
    expect(res.body.answer).toContain("hi");
    expect(res.body.sources).toEqual([{ path: "README.md" }]);
    expect(res.body.grounded).toBe(true);
  });

  it("rejects an empty question with 400", async () => {
    const res = await request(appWithAi()).post(`/api/repos/${KNOWN}/ask`).send({ question: "  " });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown session", async () => {
    const res = await request(appWithAi())
      .post(`/api/repos/22222222-2222-4222-8222-222222222222/ask`)
      .send({ question: "hi" });
    expect(res.status).toBe(404);
  });

  it("returns 503 when AI is not configured", async () => {
    const res = await request(appWithAi(false)).post(`/api/repos/${KNOWN}/ask`).send({ question: "hi" });
    expect(res.status).toBe(503);
  });
});
