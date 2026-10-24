import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import type { McpConfig } from "../src/config.js";

interface ToolEnvelope {
  ok: boolean;
  status?: number;
  error?: string;
  data?: unknown;
}

function parse(result: CallToolResult): ToolEnvelope {
  const block = result.content.find((c) => c.type === "text");
  if (!block || block.type !== "text") throw new Error("no text content");
  return JSON.parse(block.text) as ToolEnvelope;
}

let reposDir: string;
let sessionId: string;
let client: Client;
let config: McpConfig;

async function connect() {
  const server = createServer(config);
  client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
}

beforeEach(async () => {
  reposDir = await mkdtemp(join(tmpdir(), "repopilot-mcp-"));
  sessionId = randomUUID();
  const files = join(reposDir, sessionId, "files");
  await mkdir(join(files, "src"), { recursive: true });
  await mkdir(join(files, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(files, "README.md"), "hello world\nsecond line\n");
  await writeFile(join(files, "src", "index.ts"), "export const x = 1;\nconsole.log('needle here');\n");
  await writeFile(join(files, "src", "util.ts"), "// nothing special\n");
  await writeFile(join(files, ".env"), "SECRET=do-not-read\n");
  await writeFile(join(files, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  await writeFile(join(files, "bin.dat"), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]));
  await writeFile(join(files, "big.txt"), "a".repeat(2048));

  // maxFileBytes = 1 KB so big.txt (2 KB) trips the size limit.
  config = {
    reposDir,
    limits: { maxFileBytes: 1024, maxListEntries: 5000, maxSearchResults: 200, maxLineLength: 300 },
  };
  await connect();
});

afterEach(async () => {
  await client.close();
  await rm(reposDir, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>): Promise<ToolEnvelope> {
  return parse((await client.callTool({ name, arguments: args })) as CallToolResult);
}

describe("list_project_files", () => {
  it("lists repo-relative paths and excludes secrets, deps, and VCS", async () => {
    const res = await call("list_project_files", { sessionId });
    expect(res.ok).toBe(true);
    const paths = (res.data as { entries: { path: string }[] }).entries.map((e) => e.path);
    expect(paths).toContain("README.md");
    expect(paths).toContain("src/index.ts");
    expect(paths).not.toContain(".env");
    expect(paths.some((p) => p.startsWith("node_modules"))).toBe(false);
  });

  it("lists a subdirectory", async () => {
    const res = await call("list_project_files", { sessionId, path: "src" });
    const paths = (res.data as { entries: { path: string }[] }).entries.map((e) => e.path);
    expect(paths.sort()).toEqual(["src/index.ts", "src/util.ts"]);
  });

  it("rejects an invalid session id", async () => {
    const res = await call("list_project_files", { sessionId: "not-a-uuid" });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
  });

  it("rejects an unknown (expired) session", async () => {
    const res = await call("list_project_files", { sessionId: randomUUID() });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
  });
});

describe("search_project_code", () => {
  it("finds matches with line numbers", async () => {
    const res = await call("search_project_code", { sessionId, query: "needle" });
    expect(res.ok).toBe(true);
    const { matches } = res.data as { matches: { path: string; line: number }[] };
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ path: "src/index.ts", line: 2 });
  });

  it("filters by extension and skips binary/oversized files", async () => {
    const md = await call("search_project_code", { sessionId, query: "needle", extension: "md" });
    expect((md.data as { matches: unknown[] }).matches).toHaveLength(0);
    // "a" appears in big.txt (oversized, skipped) and bin.dat (binary, skipped); no crash.
    const a = await call("search_project_code", { sessionId, query: "aaaa" });
    expect(a.ok).toBe(true);
  });
});

describe("read_project_file", () => {
  it("reads a file and reports the line count", async () => {
    const res = await call("read_project_file", { sessionId, path: "README.md" });
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ path: "README.md", lineCount: 3 });
    expect((res.data as { content: string }).content).toContain("hello world");
  });

  it("rejects path traversal", async () => {
    const res = await call("read_project_file", { sessionId, path: "../../../etc/passwd" });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
  });

  it("rejects absolute paths", async () => {
    const res = await call("read_project_file", { sessionId, path: "/etc/passwd" });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
  });

  it("rejects secret files", async () => {
    const res = await call("read_project_file", { sessionId, path: ".env" });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
  });

  it("returns 404 for a missing file", async () => {
    const res = await call("read_project_file", { sessionId, path: "nope.txt" });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
  });

  it("rejects oversized files", async () => {
    const res = await call("read_project_file", { sessionId, path: "big.txt" });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(413);
  });

  it("rejects binary files", async () => {
    const res = await call("read_project_file", { sessionId, path: "bin.dat" });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(415);
  });
});
