import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createRateLimiter } from "../src/middleware/rateLimit.js";
import { createAiService } from "../src/services/aiService.js";
import type { RepoService } from "../src/services/githubService.js";
import type { McpClient } from "../src/services/mcpClient.js";
import type { RepoSession } from "../src/services/sessionStore.js";

// ---- Unit: the middleware factory ----

function fakeRes(): Response {
  return { setHeader() {} } as unknown as Response;
}

describe("createRateLimiter (unit)", () => {
  it("allows up to `max` requests per IP then rejects with 429, isolated per IP", () => {
    let clock = 1000;
    const limiter = createRateLimiter({ windowMs: 1000, max: 2, now: () => clock });

    const run = (ip: string): unknown => {
      let captured: unknown;
      limiter({ ip } as Request, fakeRes(), ((err?: unknown) => {
        captured = err;
      }) as NextFunction);
      return captured;
    };

    expect(run("1.1.1.1")).toBeUndefined();
    expect(run("1.1.1.1")).toBeUndefined();
    expect(run("1.1.1.1")).toMatchObject({ statusCode: 429 });

    // A different IP has its own budget.
    expect(run("2.2.2.2")).toBeUndefined();

    // After the window passes, the first IP is allowed again.
    clock += 1001;
    expect(run("1.1.1.1")).toBeUndefined();
  });
});

// ---- Integration: the real endpoints ----

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
    filesDir: "/tmp/nope",
  };
}

const KNOWN = "11111111-1111-4111-8111-111111111111";

const repoService = {
  connect: async () => fakeSession(KNOWN),
  get: (id: string) => (id === KNOWN ? fakeSession(id) : undefined),
  disconnect: async () => true,
  sweepOrphans: async () => 0,
  shutdown: () => {},
} as unknown as RepoService;

const mcp: McpClient = {
  async callTool() {
    return { entries: [] };
  },
  async close() {},
};

/** Fresh app per call => isolated limiter store (no cross-test flakiness). */
function appWithLimits(connectMax: number, browseMax: number) {
  return createApp({
    webOrigin: "http://localhost:5173",
    repoService,
    mcpClient: mcp,
    rateLimit: { windowMs: 60_000, connectMax, browseMax },
  });
}

describe("rate limiting on repository endpoints", () => {
  it("allows connects within the limit, then returns a safe 429", async () => {
    const app = appWithLimits(2, 100);

    const a = await request(app).post("/api/repos").send({ url: "https://github.com/o/r" });
    const b = await request(app).post("/api/repos").send({ url: "https://github.com/o/r" });
    const c = await request(app).post("/api/repos").send({ url: "https://github.com/o/r" });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(c.status).toBe(429);
    expect(c.body.error).toBeTruthy();
    expect(c.headers["retry-after"]).toBeTruthy();
    // No internal details leaked.
    expect(JSON.stringify(c.body)).not.toContain("/tmp/");
  });

  it("allows browsing within the limit, then returns 429", async () => {
    const app = appWithLimits(100, 2);

    const first = await request(app).get(`/api/repos/${KNOWN}/files`);
    const second = await request(app).get(`/api/repos/${KNOWN}/files`);
    const third = await request(app).get(`/api/repos/${KNOWN}/files`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
  });

  it("limits connect and browse budgets independently", async () => {
    const app = appWithLimits(1, 1);

    // Exhaust the connect budget.
    expect((await request(app).post("/api/repos").send({ url: "https://github.com/o/r" })).status).toBe(201);
    expect((await request(app).post("/api/repos").send({ url: "https://github.com/o/r" })).status).toBe(429);

    // Browsing still has its own separate budget.
    expect((await request(app).get(`/api/repos/${KNOWN}/files`)).status).toBe(200);
    expect((await request(app).get(`/api/repos/${KNOWN}/files`)).status).toBe(429);
  });

  it("does not apply the per-IP browse limiter to the Ask endpoint (AI has its own per-session limit)", async () => {
    const aiService = createAiService(
      { apiKey: "test-key", model: "gemini-test", timeoutMs: 5000 },
      {
        mcp,
        generate: async () => ({ answer: "ok", sources: [] }),
      },
    );
    const app = createApp({
      webOrigin: "http://localhost:5173",
      repoService,
      mcpClient: mcp,
      aiService,
      rateLimit: { windowMs: 60_000, connectMax: 100, browseMax: 1 },
    });

    expect((await request(app).get(`/api/repos/${KNOWN}/files`)).status).toBe(200);
    expect((await request(app).get(`/api/repos/${KNOWN}/files`)).status).toBe(429);
    // Ask is still accepted — the AI service enforces its own per-session budget.
    const ask = await request(app).post(`/api/repos/${KNOWN}/ask`).send({ question: "what is this?" });
    expect(ask.status).toBe(200);
  });

  it("ignores X-Forwarded-For when trust proxy is disabled (default)", async () => {
    const app = createApp({
      webOrigin: "http://localhost:5173",
      repoService,
      mcpClient: mcp,
      rateLimit: { windowMs: 60_000, connectMax: 1, browseMax: 100 },
      trustProxy: false,
    });

    const first = await request(app)
      .post("/api/repos")
      .set("X-Forwarded-For", "9.9.9.9")
      .send({ url: "https://github.com/o/r" });
    const spoofed = await request(app)
      .post("/api/repos")
      .set("X-Forwarded-For", "8.8.8.8")
      .send({ url: "https://github.com/o/r" });

    expect(first.status).toBe(201);
    // Same socket IP, so the forged header cannot reset the budget.
    expect(spoofed.status).toBe(429);
  });

  it("honors X-Forwarded-For only when trust proxy is configured", async () => {
    const app = createApp({
      webOrigin: "http://localhost:5173",
      repoService,
      mcpClient: mcp,
      rateLimit: { windowMs: 60_000, connectMax: 1, browseMax: 100 },
      trustProxy: 1,
    });

    const a = await request(app)
      .post("/api/repos")
      .set("X-Forwarded-For", "1.1.1.1")
      .send({ url: "https://github.com/o/r" });
    const b = await request(app)
      .post("/api/repos")
      .set("X-Forwarded-For", "2.2.2.2")
      .send({ url: "https://github.com/o/r" });
    const aAgain = await request(app)
      .post("/api/repos")
      .set("X-Forwarded-For", "1.1.1.1")
      .send({ url: "https://github.com/o/r" });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(aAgain.status).toBe(429);
  });
});
