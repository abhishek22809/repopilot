import { describe, expect, it } from "vitest";
import { clampSourceLines, createAiService, type AiService } from "../src/services/aiService.js";
import type { GenerateFn, GenerateInput } from "../src/services/geminiClient.js";
import { parseModelAnswer, sanitizeModelAnswer } from "../src/services/geminiClient.js";
import type { McpClient } from "../src/services/mcpClient.js";
import type { GeminiConfig } from "../src/utils/env.js";
import { RepoError } from "../src/utils/RepoError.js";

const CONFIG: GeminiConfig = { apiKey: "test-key", model: "gemini-test", timeoutMs: 5000 };

interface MockMcp extends McpClient {
  calls: { name: string; args: Record<string, unknown> }[];
}

function makeMcp(options: { sessionGone?: boolean } = {}): MockMcp {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    async callTool(name, args) {
      calls.push({ name, args });
      if (options.sessionGone) throw new RepoError(404, "Session not found or expired.");
      if (name === "search_project_code") {
        return { matches: [{ path: "src/index.ts", line: 2, text: "const x = 1;" }] };
      }
      if (name === "list_project_files") {
        return {
          entries: [
            { path: "README.md", type: "file" },
            { path: "src/index.ts", type: "file" },
          ],
        };
      }
      if (name === "read_project_file") {
        return { path: args.path, lineCount: 3, content: "line a\nconst x = 1;\nline c" };
      }
      return {};
    },
    async close() {},
  };
}

async function expectStatus(promise: Promise<unknown>, status: number): Promise<void> {
  await expect(promise).rejects.toMatchObject({ statusCode: status });
}

describe("createAiService.ask", () => {
  it("answers using context retrieved through the MCP client", async () => {
    const mcp = makeMcp();
    let captured: GenerateInput | undefined;
    const generate: GenerateFn = async (input) => {
      captured = input;
      return { answer: "It exports a constant.", sources: [{ path: "src/index.ts", lines: "2" }] };
    };
    const ai = createAiService(CONFIG, { mcp, generate });

    const result = await ai.ask("session-1", "What does index export?");

    expect(result.answer).toBe("It exports a constant.");
    expect(result.sources).toEqual([{ path: "src/index.ts", lines: "2" }]);
    expect(result.grounded).toBe(true);

    // Context must come via MCP tools, and the file content must reach the model.
    const toolNames = mcp.calls.map((c) => c.name);
    expect(toolNames).toContain("search_project_code");
    expect(toolNames).toContain("read_project_file");
    expect(captured?.prompt).toContain("const x = 1;");
    expect(captured?.system).toMatch(/UNTRUSTED DATA/);
  });

  it("drops cited sources that were not in the retrieved context", async () => {
    const generate: GenerateFn = async () => ({
      answer: "See the config loader.",
      sources: [{ path: "does/not/exist.ts" }, { path: "src/index.ts" }],
    });
    const ai = createAiService(CONFIG, { mcp: makeMcp(), generate });

    const result = await ai.ask("s", "where is config loaded?");
    expect(result.sources).toEqual([{ path: "src/index.ts" }]);
  });

  it("rejects empty and overly long questions", async () => {
    const ai = createAiService(CONFIG, { mcp: makeMcp(), generate: async () => ({ answer: "x", sources: [] }) });
    await expectStatus(ai.ask("s", "   "), 400);
    await expectStatus(ai.ask("s", "a".repeat(2001)), 400);
  });

  it("returns 503 when no API key is configured", async () => {
    const ai = createAiService({ ...CONFIG, apiKey: undefined }, { mcp: makeMcp() });
    expect(ai.isConfigured()).toBe(false);
    await expectStatus(ai.ask("s", "hello?"), 503);
  });

  it("propagates provider failures", async () => {
    const generate: GenerateFn = async () => {
      throw new RepoError(502, "The AI provider returned an error.");
    };
    const ai = createAiService(CONFIG, { mcp: makeMcp(), generate });
    await expectStatus(ai.ask("s", "explain the build"), 502);
  });

  it("propagates an expired session from MCP", async () => {
    const ai = createAiService(CONFIG, {
      mcp: makeMcp({ sessionGone: true }),
      generate: async () => ({ answer: "x", sources: [] }),
    });
    await expectStatus(ai.ask("s", "what is here"), 404);
  });

  it("retrieves README, routes/pages, and domain files for a purpose question — not package-lock.json", async () => {
    const files: Record<string, string> = {
      "README.md": "# Widgetd\nA billing CLI for invoicing customers.",
      "docs/intro.md": "Users create invoices from the checkout page.",
      "cmd/widgetd/main.go": "package main\nfunc main() {}",
      "internal/billing/invoice.go": "package billing\nfunc NewInvoice() {}",
      "web/pages/checkout.html": "<form>checkout</form>",
      "package-lock.json": "{ \"name\": \"main purpose project lock\" }",
      "frontend/src/Layout.tsx": "export function Layout() { return null }",
    };
    const listed = Object.keys(files).map((path) => ({ path, type: "file" as const }));
    const calls: MockMcp["calls"] = [];
    const mcp: MockMcp = {
      calls,
      async callTool(name, args) {
        calls.push({ name, args });
        if (name === "list_project_files") return { entries: listed };
        if (name === "search_project_code") {
          return {
            matches: [
              { path: "package-lock.json", line: 1, text: "main purpose project lock" },
              { path: "frontend/src/Layout.tsx", line: 1, text: "Layout" },
            ],
          };
        }
        if (name === "read_project_file") {
          const path = String(args.path);
          return { path, lineCount: 2, content: files[path] ?? "" };
        }
        return {};
      },
      async close() {},
    };
    let captured: GenerateInput | undefined;
    const generate: GenerateFn = async (input) => {
      captured = input;
      return { answer: "Widgetd invoices customers.", sources: [{ path: "README.md" }] };
    };
    const ai = createAiService(CONFIG, { mcp, generate });
    const result = await ai.ask("s", "What is the main purpose of this project?");

    expect(calls.every((c) => ["list_project_files", "search_project_code", "read_project_file"].includes(c.name))).toBe(
      true,
    );
    expect(result.contextFiles).toContain("README.md");
    expect(result.contextFiles.some((p) => /checkout|invoice|main\.go|intro\.md/.test(p))).toBe(true);
    expect(result.contextFiles).not.toContain("package-lock.json");
    expect(captured?.prompt).toContain("Widgetd");
    expect(captured?.prompt).not.toContain("main purpose project lock");
  });

  it("traces UI → Redux slice → API client → backend route through MCP hops", async () => {
    const files: Record<string, string> = {
      "frontend/src/pages/AddMedicine.tsx":
        'import { addMedicine } from "../store/medicinesSlice";\ndispatch(addMedicine(form));\n',
      "frontend/src/store/medicinesSlice.ts":
        'import { api } from "../api/client";\nexport const addMedicine = (b) => api.post("/api/medicines", b);\n',
      "frontend/src/api/client.ts":
        'export const api = { post: (url, body) => fetch(url, { method: "POST", body }) };\n',
      "backend/routes/medicines.js":
        'router.post("/api/medicines", createMedicine);\n',
      "backend/controllers/medicineController.js":
        "export function createMedicine(req, res) { res.json({}); }\n",
      "package-lock.json": '{ "name": "lock" }',
    };
    const listed = Object.keys(files).map((path) => ({ path, type: "file" as const }));
    const calls: MockMcp["calls"] = [];
    const mcp: MockMcp = {
      calls,
      async callTool(name, args) {
        calls.push({ name, args });
        if (name === "list_project_files") return { entries: listed };
        if (name === "search_project_code") {
          const q = String(args.query).toLowerCase();
          const matches = Object.entries(files)
            .filter(([, content]) => content.toLowerCase().includes(q) || q.split("/").some((p) => p && content.toLowerCase().includes(p)))
            .map(([path]) => ({ path, line: 1, text: files[path]!.slice(0, 80) }));
          return { matches };
        }
        if (name === "read_project_file") {
          const path = String(args.path);
          if (!(path in files)) throw new RepoError(404, "File not found.");
          return { path, lineCount: 2, content: files[path] };
        }
        return {};
      },
      async close() {},
    };
    let captured: GenerateInput | undefined;
    const generate: GenerateFn = async (input) => {
      captured = input;
      return {
        answer: "UI dispatches addMedicine, the slice posts via the API client, the backend route handles /api/medicines.",
        sources: [
          { path: "frontend/src/pages/AddMedicine.tsx" },
          { path: "frontend/src/store/medicinesSlice.ts" },
          { path: "frontend/src/api/client.ts" },
          { path: "backend/routes/medicines.js" },
        ],
      };
    };
    const ai = createAiService(CONFIG, { mcp, generate });
    const result = await ai.ask(
      "s",
      "Trace how adding a medicine works from the UI to the API and Redux state.",
    );

    expect(calls.every((c) => ["list_project_files", "search_project_code", "read_project_file"].includes(c.name))).toBe(
      true,
    );
    expect(result.contextFiles).toEqual(
      expect.arrayContaining([
        "frontend/src/pages/AddMedicine.tsx",
        "frontend/src/store/medicinesSlice.ts",
        "frontend/src/api/client.ts",
        "backend/routes/medicines.js",
      ]),
    );
    expect(result.sources.map((s) => s.path)).toEqual(
      expect.arrayContaining([
        "frontend/src/pages/AddMedicine.tsx",
        "frontend/src/store/medicinesSlice.ts",
        "frontend/src/api/client.ts",
        "backend/routes/medicines.js",
      ]),
    );
    expect(captured?.prompt).toContain("addMedicine");
    expect(captured?.prompt).toContain("/api/medicines");
    expect(captured?.prompt).not.toMatch(/<TRACE>/);
    expect(captured?.prompt).not.toMatch(/Retrieval notes \(not repository source\)/);
    expect(captured?.system).toMatch(/POST \/api\/medicines/);
    expect(captured?.system).toMatch(/matching backend route\/controller was retrieved/i);
    expect(captured?.system).toMatch(/UI event/);
    expect(captured?.system).toMatch(/Code verified in the repository/);
    expect(result.answer).not.toMatch(/no matching backend implementation/i);
  });

  it("states that a frontend-only repository has no matching backend implementation", async () => {
    const files: Record<string, string> = {
      "src/pages/AddMedicine.tsx":
        'import { addMedicine } from "../store/medicinesSlice";\ndispatch(addMedicine(form));\n',
      "src/store/medicinesSlice.ts":
        'import { api } from "../api/client";\nexport const addMedicine = (b) => api.post("/api/medicines", b);\n',
      "src/api/client.ts":
        'export const api = { post: (url, body) => fetch(url, { method: "POST", body }) };\n',
      "package.json": '{ "name": "pharmacy-web" }',
    };
    const listed = Object.keys(files).map((path) => ({ path, type: "file" as const }));
    const calls: MockMcp["calls"] = [];
    const mcp: MockMcp = {
      calls,
      async callTool(name, args) {
        calls.push({ name, args });
        if (name === "list_project_files") return { entries: listed };
        if (name === "search_project_code") {
          const q = String(args.query).toLowerCase();
          return {
            matches: Object.keys(files)
              .filter((p) => files[p]!.toLowerCase().includes(q) || p.toLowerCase().includes(q))
              .map((path) => ({ path, line: 1, text: files[path]!.slice(0, 40) })),
          };
        }
        if (name === "read_project_file") {
          const path = String(args.path);
          if (!(path in files)) throw new RepoError(404, "File not found.");
          return { path, lineCount: 2, content: files[path] };
        }
        return {};
      },
      async close() {},
    };
    let captured: GenerateInput | undefined;
    const generate: GenerateFn = async (input) => {
      captured = input;
      return {
        answer: "The UI dispatches addMedicine and the slice posts through the API client.",
        sources: [
          { path: "src/pages/AddMedicine.tsx" },
          { path: "src/store/medicinesSlice.ts" },
          { path: "src/api/client.ts" },
          { path: "backend/routes/medicines.js" },
        ],
      };
    };
    const result = await createAiService(CONFIG, { mcp, generate }).ask(
      "s",
      "Trace how adding a medicine works from the UI to the API and Redux state.",
    );

    expect(calls.filter((c) => c.name === "search_project_code" && String(c.args.query).startsWith("/"))).toEqual(
      [],
    );
    expect(result.contextFiles).toEqual(
      expect.arrayContaining(["src/pages/AddMedicine.tsx", "src/store/medicinesSlice.ts", "src/api/client.ts"]),
    );
    expect(result.contextFiles.every((p) => !p.includes("backend") && !p.includes("controller"))).toBe(true);
    expect(result.sources.map((s) => s.path)).toEqual(
      expect.arrayContaining([
        "src/pages/AddMedicine.tsx",
        "src/store/medicinesSlice.ts",
        "src/api/client.ts",
      ]),
    );
    expect(result.sources.map((s) => s.path)).not.toContain("backend/routes/medicines.js");
    expect(result.answer).toMatch(/no matching backend implementation/i);
    expect(result.answer).toMatch(/cannot be verified from this repository/i);
    expect(captured?.prompt).toContain("POST");
    expect(captured?.prompt).toContain("/api/medicines");
    expect(captured?.prompt).not.toMatch(/<TRACE>/);
    expect(captured?.prompt).not.toMatch(/no matching backend implementation/i);
    expect(captured?.system).toMatch(/no matching backend implementation/i);
    expect(captured?.system).toMatch(/Code verified in the repository/);
    expect(captured?.system).toMatch(/external API call whose server implementation is unavailable/);
    expect(captured?.system).toMatch(/cannot be determined from the available code/);
  });

  it("follows hops in a non-Redux Python layout", async () => {
    const files: Record<string, string> = {
      "ui/add_item.py": "from data.item_api import create_item\ncreate_item(payload)\n",
      "data/item_api.py": 'def create_item(p):\n    return http_post("/items", p)\n',
      "server/items.py": '@app.post("/items")\ndef add_item():\n    return {}\n',
    };
    const listed = Object.keys(files).map((path) => ({ path, type: "file" as const }));
    const mcp: MockMcp = {
      calls: [],
      async callTool(name, args) {
        if (name === "list_project_files") return { entries: listed };
        if (name === "search_project_code") {
          const q = String(args.query).toLowerCase();
          return {
            matches: Object.keys(files)
              .filter((p) => files[p]!.toLowerCase().includes(q) || p.toLowerCase().includes(q))
              .map((path) => ({ path, line: 1, text: files[path]!.slice(0, 40) })),
          };
        }
        if (name === "read_project_file") {
          const path = String(args.path);
          return { path, lineCount: 2, content: files[path] ?? "" };
        }
        return {};
      },
      async close() {},
    };
    const result = await createAiService(CONFIG, {
      mcp,
      generate: async () => ({
        answer: "ui/add_item.py calls create_item; data/item_api.py posts /items; server/items.py handles it.",
        sources: Object.keys(files).map((path) => ({ path })),
      }),
    }).ask("s", "How does adding an item work?");
    expect(result.contextFiles).toEqual(
      expect.arrayContaining(["ui/add_item.py", "data/item_api.py", "server/items.py"]),
    );
  });

  function repoMcp(files: Record<string, string>): MockMcp {
    const listed = Object.keys(files).map((path) => ({ path, type: "file" as const }));
    const calls: MockMcp["calls"] = [];
    return {
      calls,
      async callTool(name, args) {
        calls.push({ name, args });
        if (name === "list_project_files") return { entries: listed };
        if (name === "search_project_code") {
          const q = String(args.query).toLowerCase();
          return {
            matches: Object.keys(files)
              .filter((p) => files[p]!.toLowerCase().includes(q) || p.toLowerCase().includes(q))
              .map((path) => ({ path, line: 1, text: files[path]!.slice(0, 60) })),
          };
        }
        if (name === "read_project_file") {
          const path = String(args.path);
          if (!(path in files)) throw new RepoError(404, "File not found.");
          return { path, lineCount: 2, content: files[path] };
        }
        return {};
      },
      async close() {},
    };
  }

  it("traces a Vue store + HTTP client with no server implementation", async () => {
    const mcp = repoMcp({
      "src/views/Checkout.vue":
        'import { placeOrder } from "../stores/checkout.js";\nplaceOrder(cart);\n',
      "src/stores/checkout.js":
        'import { http } from "../lib/http.js";\nexport function placeOrder(cart) { return http.post("/pay", cart); }\n',
      "src/lib/http.js":
        'export const http = { post: (url, body) => fetch(url, { method: "POST", body }) };\n',
    });
    let captured: GenerateInput | undefined;
    const result = await createAiService(CONFIG, {
      mcp,
      generate: async (input) => {
        captured = input;
        return {
          answer: "Checkout.vue calls placeOrder; the store posts /pay.",
          sources: [
            { path: "src/views/Checkout.vue" },
            { path: "src/stores/checkout.js" },
            { path: "src/lib/http.js" },
            { path: "server/pay.py" },
          ],
        };
      },
    }).ask("s", "How does checkout work?");

    expect(mcp.calls.filter((c) => c.name === "search_project_code" && String(c.args.query).startsWith("/"))).toEqual(
      [],
    );
    expect(result.contextFiles).toEqual(
      expect.arrayContaining(["src/views/Checkout.vue", "src/stores/checkout.js", "src/lib/http.js"]),
    );
    expect(result.contextFiles.every((p) => !p.startsWith("server/"))).toBe(true);
    expect(result.sources.map((s) => s.path)).not.toContain("server/pay.py");
    expect(result.answer).toMatch(/no matching backend implementation/i);
    expect(captured?.prompt).toContain("/pay");
    expect(captured?.prompt).not.toMatch(/Retrieval notes \(not repository source\)/);
    expect(captured?.system).toMatch(/POST \/pay/);
    expect(captured?.system).toMatch(/Inference/);
    expect(captured?.system).toMatch(/Do not assume Redux/);
  });

  it("traces a browser script to a matching Go handler", async () => {
    const mcp = repoMcp({
      "web/order_form.js":
        'import { sendOrder } from "./orders_api.js";\nsendOrder(form);\n',
      "web/orders_api.js":
        'export function sendOrder(payload) { return fetch("/orders", { method: "POST", body: JSON.stringify(payload) }).then(r => r.json()); }\n',
      "internal/http/orders.go": 'func Mount(mux *http.ServeMux) { mux.HandleFunc("/orders", createOrder) }\n',
    });
    let captured: GenerateInput | undefined;
    const result = await createAiService(CONFIG, {
      mcp,
      generate: async (input) => {
        captured = input;
        return {
          answer: "order_form.js calls sendOrder; orders_api.js posts /orders; internal/http/orders.go handles it.",
          sources: [
            { path: "web/order_form.js" },
            { path: "web/orders_api.js" },
            { path: "internal/http/orders.go" },
          ],
        };
      },
    }).ask("s", "Trace how placing an order works from the UI to the API.");

    expect(result.contextFiles).toEqual(
      expect.arrayContaining(["web/order_form.js", "web/orders_api.js", "internal/http/orders.go"]),
    );
    expect(result.sources.map((s) => s.path)).toContain("internal/http/orders.go");
    expect(result.answer).not.toMatch(/no matching backend implementation/i);
    expect(captured?.prompt).toContain("/orders");
    expect(captured?.system).toMatch(/POST \/orders/);
    expect(captured?.system).toMatch(/request payload appears in source/);
    expect(captured?.system).toMatch(/matching backend route\/controller was retrieved/i);
  });

  it("follows a Rust CLI module graph that has no HTTP layer", async () => {
    const mcp = repoMcp({
      "src/main.rs": "mod tickets;\nuse tickets::create_ticket;\nfn main() { create_ticket(); }\n",
      "src/tickets.rs": "pub fn create_ticket() {}\n",
    });
    const result = await createAiService(CONFIG, {
      mcp,
      generate: async () => ({
        answer: "main.rs calls create_ticket in tickets.rs. No HTTP client is present.",
        sources: [{ path: "src/main.rs" }, { path: "src/tickets.rs" }],
      }),
    }).ask("s", "How does creating a ticket work?");
    expect(result.contextFiles).toEqual(expect.arrayContaining(["src/main.rs", "src/tickets.rs"]));
    expect(result.answer).not.toMatch(/no matching backend implementation/i);
    expect(result.sources.map((s) => s.path)).toEqual(expect.arrayContaining(["src/main.rs", "src/tickets.rs"]));
  });

  it("retrieves a referenced API client that was not in the seed context", async () => {
    const mcp = repoMcp({
      "src/ui/Panel.jsx": 'import { useSave } from "../hooks/useSave.js";\nuseSave().save(item);\n',
      "src/hooks/useSave.js":
        'import { saveItem } from "services/http";\nexport function useSave() { return { save: saveItem }; }\n',
      "src/services/http.js":
        'export function saveItem(body) { return fetch("/items", { method: "POST", body }).then(r => r.json()); }\n',
    });
    let captured: GenerateInput | undefined;
    const result = await createAiService(CONFIG, {
      mcp,
      generate: async (input) => {
        captured = input;
        return {
          answer: "Panel.jsx uses useSave; the hook calls saveItem; the client posts /items.",
          sources: [
            { path: "src/ui/Panel.jsx" },
            { path: "src/hooks/useSave.js" },
            { path: "src/services/http.js" },
            { path: "server/items.py" },
          ],
        };
      },
    }).ask("s", "How does saving an item work?");

    expect(mcp.calls.some((c) => c.name === "search_project_code" && /http|saveItem/i.test(String(c.args.query)))).toBe(
      true,
    );
    expect(result.contextFiles).toEqual(
      expect.arrayContaining(["src/ui/Panel.jsx", "src/hooks/useSave.js", "src/services/http.js"]),
    );
    expect(result.sources.map((s) => s.path)).toEqual(
      expect.arrayContaining(["src/ui/Panel.jsx", "src/hooks/useSave.js", "src/services/http.js"]),
    );
    expect(result.sources.map((s) => s.path)).not.toContain("server/items.py");
    expect(captured?.prompt).toContain("/items");
    expect(captured?.system).toMatch(/POST \/items/);
    expect(captured?.system).toMatch(/response handling appears in source/);
    expect(result.answer).toMatch(/cannot be verified from this repository/i);
  });

  it("distinguishes a listed API client that cannot be inspected from one that does not exist", async () => {
    const files: Record<string, string> = {
      "src/ui/Panel.jsx": 'import { useSave } from "../hooks/useSave.js";\nuseSave().save(item);\n',
      "src/hooks/useSave.js": 'import { saveItem } from "../services/http.js";\nexport function useSave() { return { save: saveItem }; }\n',
    };
    const mcp: MockMcp = {
      calls: [],
      async callTool(name, args) {
        this.calls.push({ name, args });
        if (name === "list_project_files") {
          return {
            entries: [
              { path: "src/ui/Panel.jsx", type: "file" },
              { path: "src/hooks/useSave.js", type: "file" },
              { path: "src/services/http.js", type: "file" },
            ],
          };
        }
        if (name === "search_project_code") {
          const q = String(args.query).toLowerCase();
          const listed = ["src/ui/Panel.jsx", "src/hooks/useSave.js", "src/services/http.js"];
          return {
            matches: listed
              .filter((p) => p.toLowerCase().includes(q) || (files[p] ?? "").toLowerCase().includes(q))
              .map((path) => ({ path, line: 1, text: (files[path] ?? path).slice(0, 40) })),
          };
        }
        if (name === "read_project_file") {
          const path = String(args.path);
          if (path === "src/services/http.js") throw new RepoError(404, "File not found.");
          if (!(path in files)) throw new RepoError(404, "File not found.");
          return { path, lineCount: 2, content: files[path] };
        }
        return {};
      },
      async close() {},
    };
    let captured: GenerateInput | undefined;
    const result = await createAiService(CONFIG, {
      mcp,
      generate: async (input) => {
        captured = input;
        return {
          answer: "The hook calls saveItem.",
          sources: [{ path: "src/hooks/useSave.js" }, { path: "src/services/http.js" }, { path: "invented.ts" }],
        };
      },
    }).ask("s", "How does saving an item work?");
    expect(result.contextFiles).not.toContain("src/services/http.js");
    expect(result.sources.map((s) => s.path)).not.toContain("src/services/http.js");
    expect(result.sources.map((s) => s.path)).not.toContain("invented.ts");
    expect(result.answer).toMatch(/could not be retrieved or inspected/i);
    expect(captured?.system).toMatch(
      /src\/services\/http\.js is listed in the repository but could not be retrieved or inspected/,
    );
    expect(captured?.system).not.toMatch(/src\/services\/http\.js was not found in the repository/);
    expect(captured?.prompt).not.toMatch(/could not be retrieved or inspected/i);
  });

  it("reports a referenced client module that is not in the repository listing", async () => {
    const mcp = repoMcp({
      "src/ui/Panel.jsx": 'import { useSave } from "../hooks/useSave.js";\nuseSave().save(item);\n',
      "src/hooks/useSave.js":
        'import { saveItem } from "services/ghost";\nexport function useSave() { return { save: saveItem }; }\n',
    });
    const result = await createAiService(CONFIG, {
      mcp,
      generate: async () => ({
        answer: "The hook imports saveItem.",
        sources: [{ path: "src/hooks/useSave.js" }, { path: "src/services/ghost.js" }],
      }),
    }).ask("s", "How does saving an item work?");
    expect(result.contextFiles).not.toContain("src/services/ghost.js");
    expect(result.sources.map((s) => s.path)).not.toContain("src/services/ghost.js");
    expect(result.answer).toMatch(/was not found in the repository/i);
  });

  it("retrieves a barrel re-export implementation before calling it unknown", async () => {
    const mcp = repoMcp({
      "src/ui/List.jsx": 'import { loadItems } from "../store/index.js";\nexport const List = () => loadItems;\n',
      "src/store/index.js": 'export { loadItems } from "./itemsSlice.js";\n',
      "src/store/itemsSlice.js": "export function loadItems() { return fetch(\"/items\"); }\n",
    });
    const result = await createAiService(CONFIG, {
      mcp,
      generate: async () => ({
        answer: "List imports loadItems from the store barrel; itemsSlice.js implements it.",
        sources: [{ path: "src/store/itemsSlice.js" }, { path: "src/missing.js" }],
      }),
    }).ask("s", "How does loading items work?");
    expect(result.contextFiles).toEqual(
      expect.arrayContaining(["src/ui/List.jsx", "src/store/index.js", "src/store/itemsSlice.js"]),
    );
    expect(result.sources.map((s) => s.path)).toEqual(["src/store/itemsSlice.js"]);
    expect(result.sources.map((s) => s.path)).not.toContain("src/missing.js");
  });

  it("retrieves an imported implementation even when decoy imports would fill the file budget", async () => {
    const mcp = repoMcp({
      "src/pages/Board.jsx":
        'import { theme } from "../theme.js";\nimport { Layout } from "../layout.js";\nimport { Header } from "../Header.js";\nimport { Footer } from "../Footer.js";\nimport { useBoardData } from "../hooks/useBoardData.js";\nexport const Board = () => useBoardData().load();\n',
      "src/theme.js": "export const theme = { color: 'x' };\n",
      "src/layout.js": "export function Layout() { return null; }\n",
      "src/Header.js": "export function Header() { return null; }\n",
      "src/Footer.js": "export function Footer() { return null; }\n",
      "src/hooks/useBoardData.js":
        'import { fetchRows } from "../lib/http.js";\nexport function useBoardData() { return { load: fetchRows }; }\n',
      "src/lib/http.js":
        'export function fetchRows() { return fetch("/rows", { method: "GET" }); }\n',
      "README.md": "A board page.",
    });
    let captured: GenerateInput | undefined;
    const result = await createAiService(CONFIG, {
      mcp,
      generate: async (input) => {
        captured = input;
        return {
          answer: "Board uses useBoardData; the hook calls fetchRows in lib/http.js.",
          sources: [
            { path: "src/pages/Board.jsx" },
            { path: "src/hooks/useBoardData.js" },
            { path: "src/lib/http.js" },
          ],
        };
      },
    }).ask("s", "How does the board load items?");

    expect(result.contextFiles).toEqual(
      expect.arrayContaining(["src/pages/Board.jsx", "src/hooks/useBoardData.js", "src/lib/http.js"]),
    );
    expect(result.contextFiles.length).toBeLessThanOrEqual(5);
    expect(captured?.prompt).toContain("fetchRows");
    expect(captured?.prompt).toContain("/rows");
    expect(captured?.prompt).not.toMatch(/<TRACE>/);
    expect(captured?.prompt).not.toMatch(/Retrieval notes \(not repository source\)/);
    expect(result.answer).not.toMatch(/omitted because the context/i);
  });

  it("does not treat a library import as a missing repository module", async () => {
    const mcp = repoMcp({
      "src/pages/Board.jsx":
        'import { useQuery } from "@tanstack/react-query";\nimport { useBoardData } from "../hooks/useBoardData.js";\nexport const Board = () => useBoardData().load();\n',
      "src/hooks/useBoardData.js":
        'import { fetchRows } from "../lib/http.js";\nexport function useBoardData() { return { load: fetchRows }; }\n',
      "src/lib/http.js":
        'export function fetchRows() { return fetch("/rows", { method: "GET" }); }\n',
    });
    let captured: GenerateInput | undefined;
    const result = await createAiService(CONFIG, {
      mcp,
      generate: async (input) => {
        captured = input;
        return {
          answer: "Board uses useBoardData; the hook calls fetchRows.",
          sources: [{ path: "src/hooks/useBoardData.js" }, { path: "src/lib/http.js" }],
        };
      },
    }).ask("s", "How does the board load items?");
    expect(result.contextFiles).toEqual(
      expect.arrayContaining(["src/pages/Board.jsx", "src/hooks/useBoardData.js", "src/lib/http.js"]),
    );
    expect(result.answer).not.toMatch(/was not found in the repository/i);
    expect(captured?.system).not.toMatch(/@tanstack\/react-query was not found/);
    expect(captured?.system).not.toMatch(/react-query was not found/);
  });

  it("resolves a .js import specifier to a .ts implementation file", async () => {
    const mcp = repoMcp({
      "src/pages/Form.tsx": 'import { submitForm } from "../api/client.js";\nsubmitForm();\n',
      "src/api/client.ts": 'export function submitForm() { return fetch("/forms", { method: "POST" }); }\n',
    });
    let captured: GenerateInput | undefined;
    const result = await createAiService(CONFIG, {
      mcp,
      generate: async (input) => {
        captured = input;
        return {
          answer: "Form.tsx imports submitForm from the API client.",
          sources: [{ path: "src/pages/Form.tsx" }, { path: "src/api/client.ts" }],
        };
      },
    }).ask("s", "How does submitting a form work?");
    expect(result.contextFiles).toEqual(expect.arrayContaining(["src/pages/Form.tsx", "src/api/client.ts"]));
    expect(captured?.prompt).toContain("submitForm");
    expect(result.sources.map((s) => s.path)).toContain("src/api/client.ts");
  });

  it("resolves a configured @ alias to the imported implementation", async () => {
    const mcp = repoMcp({
      "src/pages/Login.tsx": 'import { login } from "@/api/session";\nlogin();\n',
      "src/api/session.ts": 'export function login() { return fetch("/session", { method: "POST" }); }\n',
    });
    const result = await createAiService(CONFIG, {
      mcp,
      generate: async () => ({
        answer: "Login.tsx calls login from the session client.",
        sources: [{ path: "src/pages/Login.tsx" }, { path: "src/api/session.ts" }],
      }),
    }).ask("s", "How does login work?");
    expect(result.contextFiles).toEqual(expect.arrayContaining(["src/pages/Login.tsx", "src/api/session.ts"]));
  });

  it("resolves a scoped @api alias without assuming a framework", async () => {
    const mcp = repoMcp({
      "src/pages/Login.tsx": 'import { login } from "@api/session";\nlogin();\n',
      "src/api/session.ts": 'export function login() { return fetch("/session", { method: "POST" }); }\n',
    });
    const result = await createAiService(CONFIG, {
      mcp,
      generate: async () => ({
        answer: "Login.tsx calls login from the session client.",
        sources: [{ path: "src/pages/Login.tsx" }, { path: "src/api/session.ts" }],
      }),
    }).ask("s", "How does login work?");
    expect(result.contextFiles).toEqual(expect.arrayContaining(["src/pages/Login.tsx", "src/api/session.ts"]));
  });

  it("reports a relevant file omitted because of the context file limit", async () => {
    const mcp = repoMcp({
      "src/pages/Dash.jsx":
        'import { a } from "../api/a.js";\nimport { b } from "../api/b.js";\nimport { c } from "../api/c.js";\nimport { d } from "../api/d.js";\nimport { e } from "../api/e.js";\nimport { f } from "../api/f.js";\nexport const Dash = () => [a,b,c,d,e,f];\n',
      "src/api/a.js": "export function a() { return fetch('/a'); }\n",
      "src/api/b.js": "export function b() { return fetch('/b'); }\n",
      "src/api/c.js": "export function c() { return fetch('/c'); }\n",
      "src/api/d.js": "export function d() { return fetch('/d'); }\n",
      "src/api/e.js": "export function e() { return fetch('/e'); }\n",
      "src/api/f.js": "export function f() { return fetch('/f'); }\n",
    });
    let captured: GenerateInput | undefined;
    const result = await createAiService(CONFIG, {
      mcp,
      generate: async (input) => {
        captured = input;
        return {
          answer: "Dash imports several API helpers.",
          sources: [{ path: "src/pages/Dash.jsx" }],
        };
      },
    }).ask("s", "How does the dashboard load data?");
    expect(result.contextFiles.length).toBeLessThanOrEqual(5);
    const allClients = ["src/api/a.js", "src/api/b.js", "src/api/c.js", "src/api/d.js", "src/api/e.js", "src/api/f.js"];
    const missing = allClients.filter((path) => !result.contextFiles.includes(path));
    expect(missing.length).toBeGreaterThan(0);
    expect(captured?.system).toMatch(/omitted because the context/i);
    expect(result.answer).toMatch(/omitted because the context/i);
    expect(result.sources.every((source) => result.contextFiles.includes(source.path))).toBe(true);
  });

  it("reuses the initial symbol search to read the definition file", async () => {
    const mcp = repoMcp({
      "src/pages/Board.jsx":
        'import { loadItems } from "helpers/catalog";\nexport const Board = () => loadItems;\n',
      "README.md": "The board calls loadItems.",
      "src/helpers/catalogItems.js": "export function loadItems() { return []; }\n",
    });
    const result = await createAiService(CONFIG, {
      mcp,
      generate: async () => ({
        answer: "loadItems is defined in catalogItems.js.",
        sources: [{ path: "src/helpers/catalogItems.js", lines: "1-99" }],
      }),
    }).ask("s", "How does loadItems work?");
    expect(result.contextFiles).toContain("src/helpers/catalogItems.js");
    expect(result.sources).toEqual([{ path: "src/helpers/catalogItems.js", lines: "1-2" }]);
    expect(result.answer).not.toMatch(/was not found in the repository/i);
  });

  it("drops citation line ranges that fall outside the retrieved snippet", async () => {
    const files: Record<string, string> = {
      "src/helpers/catalogItems.js": "export function loadItems() { return []; }\n",
    };
    const mcp: MockMcp = {
      calls: [],
      async callTool(name, args) {
        this.calls.push({ name, args });
        if (name === "list_project_files") {
          return { entries: [{ path: "src/helpers/catalogItems.js", type: "file" }] };
        }
        if (name === "search_project_code") {
          return { matches: [{ path: "src/helpers/catalogItems.js", line: 1, text: "loadItems" }] };
        }
        if (name === "read_project_file") {
          return { path: "src/helpers/catalogItems.js", lineCount: 80, content: files["src/helpers/catalogItems.js"] };
        }
        return {};
      },
      async close() {},
    };
    const result = await createAiService(CONFIG, {
      mcp,
      generate: async () => ({
        answer: "loadItems is defined in catalogItems.js.",
        sources: [{ path: "src/helpers/catalogItems.js", lines: "40-50" }],
      }),
    }).ask("s", "How does loadItems work?");
    expect(result.sources).toEqual([{ path: "src/helpers/catalogItems.js" }]);
  });

  it("strips leaked retrieval notes from the model answer", async () => {
    const result = await createAiService(CONFIG, {
      mcp: makeMcp(),
      generate: async () => ({
        answer: "It exports a constant.\n<TRACE>\nRetrieval notes (not repository source)\n</TRACE>",
        sources: [{ path: "src/index.ts" }],
      }),
    }).ask("s", "What does index export?");
    expect(result.answer).toContain("It exports a constant.");
    expect(result.answer).not.toMatch(/<TRACE>/);
    expect(result.answer).not.toMatch(/Retrieval notes \(not repository source\)/);
  });

  it("does not invent a flow when no source files can be retrieved", async () => {
    const calls: MockMcp["calls"] = [];
    const mcp: MockMcp = {
      calls,
      async callTool(name, args) {
        calls.push({ name, args });
        if (name === "list_project_files") return { entries: [] };
        if (name === "search_project_code") return { matches: [] };
        if (name === "read_project_file") throw new RepoError(404, "File not found.");
        return {};
      },
      async close() {},
    };
    let captured: GenerateInput | undefined;
    const result = await createAiService(CONFIG, {
      mcp,
      generate: async (input) => {
        captured = input;
        return { answer: "See src/invented.rs for the handler.", sources: [{ path: "src/invented.rs" }] };
      },
    }).ask("s", "How does checkout work?");
    expect(calls.some((c) => c.name === "search_project_code")).toBe(true);
    expect(calls.some((c) => c.name === "list_project_files")).toBe(true);
    expect(result.contextFiles).toEqual([]);
    expect(result.sources).toEqual([]);
    expect(result.answer).toMatch(/cannot be determined from the available code/i);
    expect(captured?.prompt).toMatch(/No repository files/);
  });

  it("keeps searching ranked files when the first reads are inaccessible", async () => {
    const readable: Record<string, string> = {
      "README.md": "# Shop\nCheckout lives in web/order_form.js",
      "web/order_form.js": "export function submit() {}",
    };
    const mcp = {
      calls: [] as MockMcp["calls"],
      async callTool(name: string, args: Record<string, unknown>) {
        this.calls.push({ name, args });
        if (name === "list_project_files") {
          return {
            entries: [
              { path: "checkout/gone.ts", type: "file" },
              { path: "checkout/also_gone.ts", type: "file" },
              { path: "README.md", type: "file" },
              { path: "web/order_form.js", type: "file" },
            ],
          };
        }
        if (name === "search_project_code") {
          return {
            matches: [
              { path: "checkout/gone.ts", line: 1, text: "checkout" },
              { path: "checkout/also_gone.ts", line: 1, text: "checkout" },
            ],
          };
        }
        if (name === "read_project_file") {
          const path = String(args.path);
          if (path.startsWith("checkout/")) throw new RepoError(404, "File not found.");
          if (path in readable) return { path, lineCount: 1, content: readable[path] };
          throw new RepoError(404, "File not found.");
        }
        return {};
      },
      async close() {},
    };
    const result = await createAiService(CONFIG, {
      mcp,
      generate: async () => ({
        answer: "Checkout is described in README.md.",
        sources: [{ path: "README.md" }, { path: "checkout/gone.ts" }],
      }),
    }).ask("s", "How does checkout work?");
    expect(result.contextFiles.length).toBeGreaterThan(0);
    expect(result.contextFiles.every((p) => !p.startsWith("checkout/"))).toBe(true);
    expect(result.sources.map((s) => s.path)).not.toContain("checkout/gone.ts");
  });

  it("rate-limits repeated questions", async () => {
    const clock = 1000;
    const ai: AiService = createAiService(CONFIG, {
      mcp: makeMcp(),
      generate: async () => ({ answer: "ok", sources: [] }),
      now: () => clock,
    });
    for (let i = 0; i < 15; i += 1) {
      await ai.ask("same-session", "q");
    }
    await expectStatus(ai.ask("same-session", "one too many"), 429);
  });
});

describe("parseModelAnswer", () => {
  it("parses a JSON answer with sources", () => {
    const parsed = parseModelAnswer('{"answer":"hi","sources":[{"path":"a.ts","lines":"1-2"}]}');
    expect(parsed).toEqual({ answer: "hi", sources: [{ path: "a.ts", lines: "1-2" }] });
  });

  it("extracts JSON from a markdown fence and surrounding prose", () => {
    const parsed = parseModelAnswer('Sure.\n```json\n{"answer":"hi","sources":[{"path":"a.ts"}]}\n```\n');
    expect(parsed).toEqual({ answer: "hi", sources: [{ path: "a.ts" }] });
  });

  it("falls back to plain text when not JSON", () => {
    const parsed = parseModelAnswer("just some text");
    expect(parsed).toEqual({ answer: "just some text", sources: [] });
  });

  it("ignores malformed source entries", () => {
    const parsed = parseModelAnswer('{"answer":"x","sources":[{"nope":1},{"path":"ok.ts"}]}');
    expect(parsed.sources).toEqual([{ path: "ok.ts" }]);
  });
});

describe("sanitizeModelAnswer and clampSourceLines", () => {
  it("removes leaked TRACE scaffolding", () => {
    expect(sanitizeModelAnswer("Done.\n<TRACE>\nnotes\n</TRACE>")).toBe("Done.");
    expect(sanitizeModelAnswer("Done.\n<CONTEXT>\nFILE: a.ts\n</CONTEXT>")).toBe("Done.");
    expect(sanitizeModelAnswer("Done.\nUse only these claim kinds: verified (CONTEXT shows it)")).toBe("Done.");
  });

  it("clamps citation ranges to the retrieved file", () => {
    expect(clampSourceLines("1-99", 2)).toBe("1-2");
    expect(clampSourceLines("8", 3)).toBeUndefined();
    expect(clampSourceLines("nope", 3)).toBeUndefined();
  });
});