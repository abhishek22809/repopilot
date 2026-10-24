import { describe, expect, it } from "vitest";
import {
  applyTraceGrounding,
  classifyQuestion,
  classifyTraceRole,
  classifyUnresolvedSpecifier,
  extractEndpointHints,
  extractHookNames,
  extractHttpCalls,
  extractImportedBindings,
  extractModuleSpecifiers,
  formatTraceNotes,
  hopPathPriority,
  hopTargetsFromSource,
  inferRepoShape,
  isClientLikeSpecifier,
  isExternalModuleSpecifier,
  isLockfile,
  isRelevantRetrievalGap,
  looksLikeBackendImplementation,
  pickHopFromMatches,
  rankContextFiles,
  resolveImport,
  searchQueries,
  shouldTraceHops,
  summarizeTrace,
  traceFilePriority,
} from "../src/services/contextRetrieval.js";

describe("classifyQuestion", () => {
  it("detects purpose, architecture, and feature questions", () => {
    expect(classifyQuestion("What is the main purpose of this project?")).toBe("purpose");
    expect(classifyQuestion("How is the app architecture organized?")).toBe("architecture");
    expect(classifyQuestion("How does checkout work?")).toBe("feature");
    expect(
      classifyQuestion("Trace how adding a medicine works from the UI to the API and Redux state."),
    ).toBe("trace");
    expect(classifyQuestion("What does index export?")).toBe("general");
    expect(shouldTraceHops("trace")).toBe(true);
    expect(shouldTraceHops("feature")).toBe(true);
    expect(shouldTraceHops("purpose")).toBe(false);
  });
});

describe("rankContextFiles", () => {
  const unusualListing = [
    "README.md",
    "docs/intro.md",
    "cmd/widgetd/main.go",
    "internal/billing/invoice.go",
    "web/pages/checkout.html",
    "package-lock.json",
    "frontend/src/Layout.tsx",
    "frontend/README.md",
    "package.json",
  ];

  it("for a purpose question prefers README, docs, routes/pages, and domain modules over lockfiles", () => {
    const searchHits = new Map<string, number>([
      ["package-lock.json", 40],
      ["frontend/src/Layout.tsx", 12],
      ["frontend/README.md", 3],
    ]);
    const chosen = rankContextFiles({
      listedFiles: unusualListing,
      searchHits,
      kind: "purpose",
      keywords: ["main", "purpose", "project"],
      limit: 5,
    });

    expect(chosen).toContain("README.md");
    expect(chosen).toContain("docs/intro.md");
    expect(chosen.some((p) => p.includes("checkout") || p.includes("invoice") || p.includes("main.go"))).toBe(
      true,
    );
    expect(chosen).not.toContain("package-lock.json");
  });

  it("does not prefer package-lock.json even when it has the most search hits", () => {
    const chosen = rankContextFiles({
      listedFiles: ["package-lock.json", "src/app.ts", "README.md"],
      searchHits: new Map([
        ["package-lock.json", 99],
        ["src/app.ts", 1],
      ]),
      kind: "purpose",
      keywords: ["main"],
      limit: 2,
    });
    expect(chosen[0]).toBe("README.md");
    expect(chosen).not.toContain("package-lock.json");
  });

  it("for a feature question ranks implementation files that match the keywords", () => {
    const chosen = rankContextFiles({
      listedFiles: unusualListing,
      searchHits: new Map([["web/pages/checkout.html", 4], ["internal/billing/invoice.go", 1]]),
      kind: "feature",
      keywords: ["checkout"],
      limit: 4,
    });
    expect(chosen[0]).toBe("web/pages/checkout.html");
    expect(chosen).not.toContain("package-lock.json");
  });

  it("for feature and trace questions skips README seeds when implementation files exist", () => {
    const listed = ["README.md", "docs/guide.md", "package.json", "src/pages/Board.jsx", "src/api/client.ts"];
    const feature = rankContextFiles({
      listedFiles: listed,
      searchHits: new Map([["src/pages/Board.jsx", 2]]),
      kind: "feature",
      keywords: ["board"],
      limit: 2,
    });
    expect(feature).toContain("src/pages/Board.jsx");
    expect(feature).not.toContain("README.md");
    expect(feature).not.toContain("docs/guide.md");

    const trace = rankContextFiles({
      listedFiles: listed,
      searchHits: new Map([["src/pages/Board.jsx", 2]]),
      kind: "trace",
      keywords: ["board"],
      limit: 2,
    });
    expect(trace).not.toContain("README.md");
  });

  it("for architecture questions prefers entry points and routes over layout chrome", () => {
    const chosen = rankContextFiles({
      listedFiles: unusualListing,
      searchHits: new Map(),
      kind: "architecture",
      keywords: ["architect"],
      limit: 4,
    });
    expect(chosen).toContain("cmd/widgetd/main.go");
    expect(chosen).not.toContain("package-lock.json");
  });
});

describe("searchQueries", () => {
  it("drops purpose filler words so they do not flood lockfile search hits", () => {
    expect(searchQueries("purpose", ["main", "purpose", "project", "billing"])).toEqual(["billing"]);
  });
});

describe("import hop resolution", () => {
  const listed = [
    "frontend/src/pages/AddMedicine.tsx",
    "frontend/src/store/medicinesSlice.ts",
    "frontend/src/api/client.ts",
    "backend/routes/medicines.js",
    "backend/controllers/medicineController.js",
    "frontend/src/pages/AddMedicine.test.tsx",
  ];

  it("resolves a relative import without leaving the repo", () => {
    expect(
      resolveImport("frontend/src/pages/AddMedicine.tsx", "../store/medicinesSlice", listed),
    ).toBe("frontend/src/store/medicinesSlice.ts");
    expect(resolveImport("frontend/src/pages/AddMedicine.tsx", "../../../../etc/passwd", listed)).toBeUndefined();
  });

  it("resolves an alias to a suffixed implementation file", () => {
    expect(
      resolveImport("src/pages/Form.jsx", "@/api/forms", ["src/pages/Form.jsx", "src/api/formsApi.ts"]),
    ).toBe("src/api/formsApi.ts");
  });

  it("resolves a .js specifier to a .ts file and a scoped @api alias", () => {
    expect(
      resolveImport("src/pages/Form.tsx", "../api/client.js", ["src/pages/Form.tsx", "src/api/client.ts"]),
    ).toBe("src/api/client.ts");
    expect(
      resolveImport("src/pages/Login.tsx", "@api/session", ["src/pages/Login.tsx", "src/api/session.ts"]),
    ).toBe("src/api/session.ts");
  });

  it("orders hop paths so API/hook modules beat layout chrome", () => {
    const hops = hopTargetsFromSource(
      "src/pages/Board.jsx",
      'import { theme } from "../theme.js";\nimport { Layout } from "../layout.js";\nimport { useCatalog } from "../hooks/useCatalog.js";\n',
      ["src/pages/Board.jsx", "src/theme.js", "src/layout.js", "src/hooks/useCatalog.js", "src/api/catalogClient.js"],
    );
    expect(hops.paths[0]).toBe("src/hooks/useCatalog.js");
    expect(hopPathPriority("src/api/catalogClient.js")).toBeLessThan(hopPathPriority("src/theme.js"));
    expect(traceFilePriority("src/api/catalogClient.js", "fetch('/catalog')", ["catalog"])).toBeGreaterThan(
      traceFilePriority("src/theme.js", "export const theme = {}", ["catalog"]),
    );
  });

  it("follows a barrel re-export to the implementation module", () => {
    const hops = hopTargetsFromSource(
      "src/store/index.js",
      'export { loadItems } from "./itemsSlice.js";\n',
      ["src/store/index.js", "src/store/itemsSlice.js"],
    );
    expect(hops.paths).toContain("src/store/itemsSlice.js");
    expect(extractImportedBindings('export { loadItems } from "./itemsSlice.js";')).toContain("loadItems");
  });

  it("keeps imported bindings as hop terms even when they are not called", () => {
    const hops = hopTargetsFromSource(
      "src/pages/Board.jsx",
      'import { loadItems } from "helpers/catalog";\nexport const Board = () => loadItems;\n',
      ["src/pages/Board.jsx", "src/helpers/other.js"],
    );
    expect(hops.searchTerms).toEqual(expect.arrayContaining(["loadItems", "catalog"]));
    expect(hops.unresolvedSpecs).toContain("helpers/catalog");
  });

  it("extracts local imports, dispatched actions, and endpoint paths from a UI file", () => {
    const source = `
      import { addMedicine, uploadMedicines } from "../store/medicinesSlice";
      dispatch(addMedicine(payload));
      fetch("/api/medicines", { method: "POST" });
    `;
    expect(extractModuleSpecifiers(source)).toContain("../store/medicinesSlice");
    const hops = hopTargetsFromSource("frontend/src/pages/AddMedicine.tsx", source, listed);
    expect(hops.paths).toContain("frontend/src/store/medicinesSlice.ts");
    expect(hops.searchTerms).toEqual(expect.arrayContaining(["addMedicine", "/api/medicines", "medicines"]));
    expect(extractEndpointHints(source)).toContain("/api/medicines");
  });

  it("does not hop into test files when picking search matches", () => {
    const picked = pickHopFromMatches(
      "addMedicine",
      [
        { path: "frontend/src/pages/AddMedicine.test.tsx" },
        { path: "frontend/src/store/medicinesSlice.ts" },
      ],
      listed,
      new Set(),
    );
    expect(picked).toBe("frontend/src/store/medicinesSlice.ts");
  });

  it("prefers a backend route over an API client when searching an endpoint", () => {
    const picked = pickHopFromMatches(
      "/api/medicines",
      [
        { path: "frontend/src/api/client.ts" },
        { path: "backend/routes/medicines.js" },
      ],
      listed,
      new Set(),
      { preferBackend: true },
    );
    expect(picked).toBe("backend/routes/medicines.js");
  });

  it("returns no hop when preferBackend is set and only frontend files match", () => {
    const picked = pickHopFromMatches(
      "/api/medicines",
      [{ path: "frontend/src/api/client.ts" }],
      listed,
      new Set(),
      { preferBackend: true },
    );
    expect(picked).toBeUndefined();
  });
});

describe("HTTP call extraction and backend detection", () => {
  it("extracts method and path from an API client call", () => {
    expect(extractHttpCalls('export const addMedicine = (b) => api.post("/api/medicines", b);')).toEqual(
      expect.arrayContaining([expect.objectContaining({ method: "POST", path: "/api/medicines" })]),
    );
    expect(extractHttpCalls('fetch("/api/medicines", { method: "POST" })')).toEqual(
      expect.arrayContaining([expect.objectContaining({ method: "POST", path: "/api/medicines" })]),
    );
  });

  it("treats Express/FastAPI handlers as backend and axios wrappers as clients", () => {
    expect(
      looksLikeBackendImplementation("backend/routes/medicines.js", 'router.post("/api/medicines", createMedicine);'),
    ).toBe(true);
    expect(looksLikeBackendImplementation("frontend/src/api/client.ts", 'export const api = { post: (url) => fetch(url) };')).toBe(
      false,
    );
  });

  it("summarizes a frontend-only flow without inventing a backend stage", () => {
    const summary = summarizeTrace(
      [
        { path: "frontend/src/pages/AddMedicine.tsx", snippet: 'dispatch(addMedicine(form));' },
        { path: "frontend/src/store/medicinesSlice.ts", snippet: 'api.post("/api/medicines", body);' },
        { path: "frontend/src/api/client.ts", snippet: "export const api = { post: (url) => fetch(url) };" },
      ],
      true,
    );
    expect(summary.backendFound).toBe(false);
    expect(summary.httpCalls).toEqual(
      expect.arrayContaining([expect.objectContaining({ method: "POST", path: "/api/medicines" })]),
    );
    const notes = formatTraceNotes(summary);
    expect(notes).toMatch(/no matching backend implementation/i);
    expect(notes).toMatch(/cannot be verified from this repository/i);
    expect(applyTraceGrounding("UI dispatches addMedicine and the client posts.", summary)).toMatch(
      /no matching backend implementation/i,
    );
  });

  it("does not append a missing-backend warning when a route was retrieved", () => {
    const summary = summarizeTrace(
      [
        { path: "frontend/src/api/client.ts", snippet: 'api.post("/api/medicines", body);' },
        { path: "backend/routes/medicines.js", snippet: 'router.post("/api/medicines", createMedicine);' },
      ],
      true,
    );
    expect(summary.backendFound).toBe(true);
    expect(applyTraceGrounding("The backend route handles POST /api/medicines.", summary)).toBe(
      "The backend route handles POST /api/medicines.",
    );
  });
});

describe("isLockfile", () => {
  it("recognizes common lockfiles", () => {
    expect(isLockfile("package-lock.json")).toBe(true);
    expect(isLockfile("apps/web/package-lock.json")).toBe(true);
    expect(isLockfile("package.json")).toBe(false);
  });
});

describe("repository-independent tracing", () => {
  it("infers languages and UI vs server hints from the listed tree", () => {
    const shape = inferRepoShape([
      "web/order_form.js",
      "internal/http/orders.go",
      "go.mod",
      "package.json",
    ]);
    expect(shape.languages).toEqual(expect.arrayContaining(["JavaScript", "Go"]));
    expect(shape.treeSuggestsUi).toBe(true);
    expect(shape.treeSuggestsServer).toBe(true);
    expect(shape.configFiles).toEqual(expect.arrayContaining(["go.mod", "package.json"]));
  });

  it("resolves a Rust crate module next to main.rs", () => {
    const hops = hopTargetsFromSource(
      "src/main.rs",
      "mod tickets;\nuse tickets::create_ticket;\nfn main() { create_ticket(); }\n",
      ["src/main.rs", "src/tickets.rs"],
    );
    expect(hops.paths).toContain("src/tickets.rs");
  });

  it("resolves a Java import by class name against the listed tree", () => {
    expect(extractModuleSpecifiers("import com.shop.orders.OrderService;")).toContain("com.shop.orders.OrderService");
    expect(resolveImport("src/App.java", "com.shop.orders.OrderService", ["src/App.java", "src/orders/OrderService.java"])).toBe(
      "src/orders/OrderService.java",
    );
  });

  it("records payload and response handling only when the source shows them", () => {
    const calls = extractHttpCalls(
      'export function sendOrder(payload) { return fetch("/orders", { method: "POST", body: JSON.stringify(payload) }).then(r => r.json()); }',
    );
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "POST",
          path: "/orders",
          hasRequestPayload: true,
          hasResponseHandling: true,
        }),
      ]),
    );
  });

  it("treats a Go handler under internal/ as server code, not an API client", () => {
    expect(
      looksLikeBackendImplementation("internal/http/orders.go", 'mux.HandleFunc("/orders", createOrder)'),
    ).toBe(true);
    expect(classifyTraceRole("src/stores/checkout.js", "export function placeOrder() {}")).toBe("state");
    expect(classifyTraceRole("src/views/Checkout.vue", "placeOrder(cart)")).toBe("ui");
    expect(classifyTraceRole("src/hooks/useSave.js", "export function useSave() {}")).toBe("hook");
  });

  it("extracts custom hooks and in-repo client specifiers", () => {
    expect(extractHookNames("const { save } = useSave();\nuseEffect(() => {});")).toEqual(["useSave"]);
    expect(isClientLikeSpecifier("services/http")).toBe(true);
    expect(isClientLikeSpecifier("@/lib/http")).toBe(true);
    expect(isClientLikeSpecifier("axios")).toBe(false);
    expect(isClientLikeSpecifier("react-dom/client")).toBe(false);
  });

  it("prefers an API client file when searching for a referenced client module", () => {
    const picked = pickHopFromMatches(
      "http",
      [{ path: "README.md" }, { path: "src/services/http.js" }],
      ["README.md", "src/services/http.js"],
      new Set(),
      { preferClient: true },
    );
    expect(picked).toBe("src/services/http.js");
  });

  it("picks a Go handler over a browser script when searching an endpoint", () => {
    const picked = pickHopFromMatches(
      "/orders",
      [{ path: "web/orders_api.js" }, { path: "internal/http/orders.go" }],
      ["web/orders_api.js", "internal/http/orders.go"],
      new Set(),
      { preferBackend: true },
    );
    expect(picked).toBe("internal/http/orders.go");
  });

  it("labels empty retrieval as unknown rather than inventing a backend", () => {
    const summary = summarizeTrace([], true, []);
    expect(formatTraceNotes(summary)).toMatch(/cannot be determined from the available code/i);
    expect(applyTraceGrounding("Here is how the secret service works.", summary)).toMatch(
      /cannot be determined from the available code/i,
    );
  });

  it("distinguishes absent, unreadable, and omitted-for-limit gaps", () => {
    const summary = summarizeTrace(
      [{ path: "src/pages/Board.jsx", snippet: "useCatalog()" }],
      true,
      ["src/pages/Board.jsx", "src/hooks/useCatalog.js", "src/api/client.ts", "src/theme.js"],
      [
        { kind: "not_in_repository", specifier: "services/ghost" },
        { kind: "unreadable", path: "src/hooks/useCatalog.js" },
        { kind: "omitted_for_limit", path: "src/api/client.ts" },
      ],
    );
    const notes = formatTraceNotes(summary);
    expect(notes).toMatch(/services\/ghost was not found in the repository/);
    expect(notes).toMatch(/src\/hooks\/useCatalog\.js is listed in the repository but could not be retrieved or inspected/);
    expect(notes).toMatch(/src\/api\/client\.ts exists but was omitted because the context file or size limit was reached/);
    expect(applyTraceGrounding("Board calls useCatalog.", summary)).toMatch(/could not be retrieved or inspected/i);
    expect(applyTraceGrounding("Board calls useCatalog.", summary)).toMatch(/was not found in the repository/i);
    expect(applyTraceGrounding("Board calls useCatalog.", summary)).toMatch(/omitted because the context/i);
  });

  it("does not treat omitted layout chrome as a relevant retrieval warning", () => {
    const summary = summarizeTrace(
      [
        { path: "src/pages/Board.jsx", snippet: "useBoardData()" },
        { path: "src/lib/http.js", snippet: 'fetch("/rows", { method: "GET" })' },
      ],
      true,
      ["src/pages/Board.jsx", "src/lib/http.js", "src/theme.js"],
      [{ kind: "omitted_for_limit", path: "src/theme.js" }],
    );
    expect(isRelevantRetrievalGap({ kind: "omitted_for_limit", path: "src/theme.js" })).toBe(false);
    expect(formatTraceNotes(summary)).not.toMatch(/src\/theme\.js/);
    const grounded = applyTraceGrounding("Board loads rows through the HTTP helper.", summary);
    expect(grounded).not.toMatch(/omitted because the context/i);
    expect(grounded).toMatch(/no matching backend implementation/i);
  });

  it("does not claim the backend is absent when a server file was omitted", () => {
    const summary = summarizeTrace(
      [{ path: "src/lib/http.js", snippet: 'fetch("/rows", { method: "GET" })' }],
      true,
      ["src/lib/http.js", "internal/http/rows.go"],
      [{ kind: "omitted_for_limit", path: "internal/http/rows.go" }],
    );
    const notes = formatTraceNotes(summary);
    expect(notes).toMatch(/server-like file was listed but was not included/i);
    expect(notes).not.toMatch(/no matching backend implementation/i);
    expect(applyTraceGrounding("The client fetches /rows.", summary)).not.toMatch(
      /no matching backend implementation/i,
    );
  });

  it("does not report external packages as missing repository modules", () => {
    expect(isExternalModuleSpecifier("@tanstack/react-query", ["src/pages/Board.jsx"])).toBe(true);
    expect(isExternalModuleSpecifier("react-dom/client", ["src/pages/Board.jsx", "src/api/client.ts"])).toBe(true);
    expect(isExternalModuleSpecifier("services/ghost", ["src/hooks/useSave.js"])).toBe(false);
    expect(isExternalModuleSpecifier("@api/session", ["src/api/session.ts"])).toBe(false);
    expect(
      classifyUnresolvedSpecifier(
        "@tanstack/react-query",
        ["src/pages/Board.jsx", "src/api/client.ts"],
        new Set(["src/pages/Board.jsx"]),
        new Set(),
      ),
    ).toBeUndefined();
    expect(
      classifyUnresolvedSpecifier("helpers/catalog", ["src/helpers/catalogItems.js"], new Set(["src/helpers/catalogItems.js"]), new Set()),
    ).toBeUndefined();
    expect(
      classifyUnresolvedSpecifier("services/ghost", ["src/hooks/useSave.js"], new Set(["src/hooks/useSave.js"]), new Set()),
    ).toEqual({ kind: "not_in_repository", specifier: "services/ghost" });
  });
});
