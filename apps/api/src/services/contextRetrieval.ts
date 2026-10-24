/** Question-aware ranking of MCP-listed files. Pure: no I/O, no Gemini. */

export type QuestionKind = "purpose" | "feature" | "architecture" | "trace" | "general";

const PURPOSE_RE =
  /\b(purpose|goal|goals|about|overview|used for|main (idea|point)|what (is|does) (this|the) (project|app|repo|application|codebase))\b/i;
const ARCH_RE =
  /\b(architect|structur|organiz|entry ?point|routing|how (is|does).+(start|boot|wired|organized)|tech stack|stack)\b/i;
const FEATURE_RE = /\b(how (do|does|to)|where (is|does)|feature|implement|handle|workflow|user flow)\b/i;
const TRACE_RE =
  /\b(trace|end[- ]to[- ]end|from the (ui|frontend|client)|to the api|redux|through the (stack|api|backend))\b/i;

const LOCKFILE_RE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock|composer\.lock|cargo\.lock|poetry\.lock|gemfile\.lock|go\.sum)$/i;
const README_RE = /(^|\/)readme(\.[a-z0-9]+)?$/i;
const DOC_RE = /(^|\/)(docs?|documentation)\//i;
const MANIFEST_RE =
  /(^|\/)(package\.json|pyproject\.toml|cargo\.toml|go\.mod|composer\.json|gemfile)$/i;
const ENTRY_RE =
  /(^|\/)(main|index|app|server|__main__)(\.[a-z0-9]+)?$|(^|\/)cmd\/[^/]+\/main\.[a-z0-9]+$/i;
const ROUTE_PAGE_RE = /(route|router|routes|pages?|views?|screens?)\.[a-z0-9]+$|\/(pages?|app|views|screens|routes|handlers)\//i;
const DOMAIN_RE = /\/(services?|domain|features?|modules?|controllers?|handlers?|use-?cases?|internal|pkg)\//i;
const STYLE_LAYOUT_RE =
  /\.(css|scss|sass|less|svg)$|\/(layout|header|footer|theme|styles?|assets|public)\//i;

export function classifyQuestion(question: string): QuestionKind {
  if (PURPOSE_RE.test(question)) return "purpose";
  if (TRACE_RE.test(question)) return "trace";
  if (ARCH_RE.test(question)) return "architecture";
  if (FEATURE_RE.test(question)) return "feature";
  return "general";
}

/** Follow imports/calls for end-to-end and “how does X work” questions. */
export function shouldTraceHops(kind: QuestionKind): boolean {
  return kind === "trace" || kind === "feature";
}

export function isLockfile(path: string): boolean {
  return LOCKFILE_RE.test(path.replaceAll("\\", "/"));
}

function posix(path: string): string {
  return path.replaceAll("\\", "/");
}

function depth(path: string): number {
  return posix(path).split("/").filter(Boolean).length;
}

function nameScore(path: string, keywords: string[]): number {
  if (keywords.length === 0) return 0;
  const lower = posix(path).toLowerCase();
  let score = 0;
  for (const word of keywords) {
    if (lower.includes(word)) score += 18;
  }
  return score;
}

function structuralScore(path: string, kind: QuestionKind): number {
  const p = posix(path);
  if (isLockfile(p)) return -200;
  if (STYLE_LAYOUT_RE.test(p) && kind === "purpose") return -25;

  let score = 0;
  const purposeLike = kind === "purpose";
  if (README_RE.test(p)) {
    score += purposeLike ? Math.max(40, 110 - depth(p) * 8) : Math.max(10, 35 - depth(p) * 4);
  } else if (DOC_RE.test(p) && /\.md$/i.test(p)) {
    score += purposeLike ? Math.max(20, 75 - depth(p) * 5) : Math.max(8, 30 - depth(p) * 4);
  }
  if (MANIFEST_RE.test(p)) score += Math.max(15, 65 - depth(p) * 6);
  if (ENTRY_RE.test(p)) score += 50;
  if (ROUTE_PAGE_RE.test(p)) score += 45;
  if (DOMAIN_RE.test(p)) score += 40;

  if (kind === "purpose") {
    if (README_RE.test(p) || (DOC_RE.test(p) && /\.md$/i.test(p))) score += 25;
    if (MANIFEST_RE.test(p)) score += 10;
  }
  if (kind === "architecture") {
    if (ENTRY_RE.test(p) || ROUTE_PAGE_RE.test(p)) score += 20;
  }
  return score;
}

export interface RankInput {
  listedFiles: string[];
  searchHits: Map<string, number>;
  kind: QuestionKind;
  keywords: string[];
  limit: number;
}

/**
 * Pick up to `limit` repo-relative files to read. Never prefers lockfiles over
 * README / docs / manifests / entry points / routes / domain modules.
 */
export function rankContextFiles(input: RankInput): string[] {
  const candidates = new Set<string>([...input.listedFiles, ...input.searchHits.keys()]);
  const scored: { path: string; score: number }[] = [];

  for (const path of candidates) {
    const hits = input.searchHits.get(path) ?? 0;
    const hitWeight = input.kind === "feature" || input.kind === "trace" ? 12 : 4;
    const score =
      structuralScore(path, input.kind) +
      Math.min(hits, 12) * hitWeight +
      nameScore(path, input.keywords);
    scored.push({ path, score });
  }

  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const chosen: string[] = [];
  const skipDocsForFlow =
    (input.kind === "feature" || input.kind === "trace") &&
    scored.some(
      (s) =>
        !isLockfile(s.path) &&
        !README_RE.test(posix(s.path)) &&
        !DOC_RE.test(posix(s.path)) &&
        !MANIFEST_RE.test(posix(s.path)) &&
        s.score > 0,
    );
  for (const { path } of scored) {
    if (chosen.length >= input.limit) break;
    if (isLockfile(path) && scored.some((s) => !isLockfile(s.path) && s.score > 0)) {
      continue;
    }
    const p = posix(path);
    if (skipDocsForFlow && (README_RE.test(p) || (DOC_RE.test(p) && /\.md$/i.test(p)) || MANIFEST_RE.test(p))) {
      continue;
    }
    if (!chosen.includes(path)) chosen.push(path);
  }
  return chosen;
}

const EXTRA_PURPOSE_STOP = new Set([
  "main",
  "purpose",
  "project",
  "goal",
  "goals",
  "overview",
  "about",
]);

const EXTRA_ARCH_QUERIES = ["router", "listen", "createapp"];

export function searchQueries(kind: QuestionKind, keywords: string[]): string[] {
  const out: string[] = [];
  for (const word of keywords) {
    if (kind === "purpose" && EXTRA_PURPOSE_STOP.has(word)) continue;
    out.push(word);
    if (out.length >= 4) return out;
  }
  if (kind === "architecture") {
    for (const extra of EXTRA_ARCH_QUERIES) {
      if (out.includes(extra)) continue;
      out.push(extra);
      if (out.length >= 4) break;
    }
  }
  return out;
}

const SKIP_TRACE_PATH =
  /\.(test|spec)\.[a-z0-9]+$|\/(__tests__|__mocks__|fixtures|testdata)\//i;
const GENERIC_SYMBOLS = new Set([
  "dispatch",
  "usestate",
  "useeffect",
  "usememo",
  "usecallback",
  "useselector",
  "usedispatch",
  "console",
  "window",
  "document",
  "fetch",
  "axios",
  "require",
  "import",
  "export",
  "return",
  "async",
  "await",
  "function",
  "const",
  "class",
  "string",
  "number",
  "boolean",
  "undefined",
  "length",
  "map",
  "filter",
  "reduce",
  "then",
  "catch",
  "json",
  "parse",
  "stringify",
]);

export function isSkipTracePath(path: string): boolean {
  const p = posix(path);
  return isLockfile(p) || SKIP_TRACE_PATH.test(p) || STYLE_LAYOUT_RE.test(p);
}

/** Relative and in-repo module specifiers (not npm packages). */
export function extractModuleSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bfrom\s+([A-Za-z_][\w.]*)\s+import\b/g,
    /\bimport\s+([A-Za-z_][\w.]*)\s*;/g,
    /\bexport\s+\*\s+from\s+["']([^"']+)["']/g,
    /\bexport\s+\{[^}]*\}\s+from\s+["']([^"']+)["']/g,
  ];
  for (const re of patterns) {
    for (const match of source.matchAll(re)) {
      const spec = match[1]?.trim();
      if (spec) specs.push(spec);
    }
  }
  return [...new Set(specs)];
}

const REACT_HOOKS = new Set([
  "usestate",
  "useeffect",
  "usememo",
  "usecallback",
  "useselector",
  "usedispatch",
  "useref",
  "usecontext",
  "usereducer",
  "uselayouteffect",
  "useid",
]);

export function extractHookNames(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/\b(use[A-Z][A-Za-z0-9]+)\s*\(/g)) {
    const name = match[1]!;
    if (!REACT_HOOKS.has(name.toLowerCase()) && !GENERIC_SYMBOLS.has(name.toLowerCase())) {
      names.add(name);
    }
  }
  return [...names];
}

function folderInTree(name: string, listedFiles: readonly string[]): boolean {
  return listedFiles.some((file) => {
    const fp = posix(file);
    return fp.startsWith(`${name}/`) || fp.includes(`/${name}/`);
  });
}

/** True for in-repo API/http/service paths — not a hyphenated npm package export. */
export function isClientLikeSpecifier(spec: string): boolean {
  const p = posix(spec);
  if (!/(api|http|client|service|request|axios)/i.test(p)) return false;
  if (p.startsWith(".") || p.startsWith("@/")) return true;
  if (/^@[A-Za-z][A-Za-z0-9_-]*\//.test(p)) return true;
  if (/^[a-zA-Z0-9_]+-[a-zA-Z0-9._-]*\//.test(p)) return false;
  return p.includes("/");
}

export function isBarePackageSpecifier(spec: string): boolean {
  const p = posix(spec);
  return !p.startsWith(".") && !p.startsWith("@/") && !p.includes("/");
}

/**
 * npm / library specifiers that are not in-repo modules. Scoped packages are
 * external unless the scope name appears as a folder in the listed tree.
 */
export function isExternalModuleSpecifier(spec: string, listedFiles: readonly string[] = []): boolean {
  const p = posix(spec);
  if (p.startsWith(".") || p.startsWith("@/")) return false;
  if (isBarePackageSpecifier(p)) return true;
  const scoped = p.match(/^@([A-Za-z][A-Za-z0-9_-]*)\/(.+)$/);
  if (scoped) return !folderInTree(scoped[1]!, listedFiles);
  const first = p.split("/")[0];
  if (!first) return true;
  if (folderInTree(first, listedFiles)) return false;
  if (isClientLikeSpecifier(p)) return false;
  return true;
}

export function looksLikeClientPath(path: string): boolean {
  const p = posix(path);
  if (looksLikeBackendPath(p)) return false;
  return (
    /(^|\/)(api|lib|services?|hooks)\//i.test(p) ||
    /(api|http|client|service|request)\.[a-z0-9]+$/i.test(p)
  );
}

/** Local names from `import { x }` / `export { x } from` — including names not called with `()`. */
export function extractImportedBindings(source: string): string[] {
  const names = new Set<string>();
  const addLocal = (raw: string): void => {
    const local = raw.trim().split(/\s+as\s+/i).pop()?.trim() ?? "";
    if (local && /^[A-Za-z_][A-Za-z0-9_]*$/.test(local) && !GENERIC_SYMBOLS.has(local.toLowerCase())) {
      names.add(local);
    }
  };
  for (const match of source.matchAll(/\b(?:import|export)\s+\{([^}]+)\}\s+from\s+["'][^"']+["']/g)) {
    for (const part of match[1]!.split(",")) addLocal(part);
  }
  for (const match of source.matchAll(/\bimport\s+([A-Za-z_][A-Za-z0-9_]*)\s+from\s+["'][^"']+["']/g)) {
    addLocal(match[1]!);
  }
  return [...names];
}

export function extractCallNames(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/\b([A-Za-z_][A-Za-z0-9_]{2,})\s*\(/g)) {
    const name = match[1]!;
    if (!GENERIC_SYMBOLS.has(name.toLowerCase())) names.add(name);
  }
  for (const match of source.matchAll(
    /\b(?:dispatch|createAsyncThunk|createSlice)\(\s*([A-Za-z_][A-Za-z0-9_]*)/g,
  )) {
    names.add(match[1]!);
  }
  return [...names];
}

export function extractEndpointHints(source: string): string[] {
  const hints = new Set<string>();
  for (const match of source.matchAll(/["'`](\/[A-Za-z0-9_./:{}$-]{2,})["'`]/g)) {
    const raw = match[1]!;
    if (raw.startsWith("//")) continue;
    hints.add(raw);
    const last = raw.split("/").filter(Boolean).pop();
    if (last && last.length >= 3) hints.add(last);
  }
  return [...hints];
}

function stripCodeExt(base: string): string {
  return base.replace(/\.(tsx?|jsx?|mjs|cjs)$/i, "");
}

function matchListed(base: string, listed: ReadonlySet<string>): string | undefined {
  const candidates = base === stripCodeExt(base) ? [base] : [base, stripCodeExt(base)];
  const exts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".kt", ".vue", ".svelte", ".rb"];
  for (const candidate of candidates) {
    if (listed.has(candidate)) return candidate;
    for (const ext of exts) {
      if (listed.has(candidate + ext)) return candidate + ext;
    }
    for (const ext of [".ts", ".tsx", ".js", ".jsx", ".py", ".rs"]) {
      const index = `${candidate}/index${ext}`;
      if (listed.has(index)) return index;
      const init = `${candidate}/__init__.py`;
      if (listed.has(init)) return init;
    }
  }
  return undefined;
}

/** Resolve a specifier against `fromFile` without leaving the repo root. */
export function resolveImport(
  fromFile: string,
  specifier: string,
  listedFiles: readonly string[],
): string | undefined {
  const listed = new Set(listedFiles.map(posix));
  const spec = posix(specifier).replace(/\\/g, "/");

  if (spec.startsWith(".")) {
    const parts = posix(fromFile).split("/").filter(Boolean);
    parts.pop();
    for (const seg of spec.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        if (parts.length === 0) return undefined;
        parts.pop();
        continue;
      }
      parts.push(seg);
    }
    return matchListed(parts.join("/"), listed);
  }

  // `@/` and `@api/foo` path aliases, in-repo `features/cart`, or Python `data.item_api`.
  const isAtAlias = spec.startsWith("@/") || /^@[A-Za-z][A-Za-z0-9_-]*\//.test(spec);
  const isDotted = !spec.startsWith(".") && !spec.startsWith("@") && spec.includes(".");
  const isInRepoPath = !spec.startsWith(".") && !spec.startsWith("@") && spec.includes("/");
  if (!isAtAlias && !isDotted && !isInRepoPath) return undefined;
  const trimmed = (isAtAlias ? spec.replace(/^@\/?/, "") : spec.replaceAll(".", "/")).replace(/\\/g, "/");
  const baseName = trimmed.split("/").filter(Boolean).pop();
  if (!baseName || baseName.length < 2) return undefined;

  for (const prefix of ["", "src/", "app/", "lib/"]) {
    const hit = matchListed(prefix + trimmed, listed);
    if (hit) return hit;
  }

  const extras = ["Slice", "Api", "Service", "Store", "Actions", "Client", "Hook"];
  const aliasRoot = isAtAlias ? trimmed.split("/").filter(Boolean)[0] : undefined;
  const matches = listedFiles.filter((file) => {
    const p = posix(file);
    if (aliasRoot && !p.includes(`/${aliasRoot}/`) && !p.startsWith(`${aliasRoot}/`)) return false;
    const fileName = p.split("/").pop() ?? "";
    const stem = fileName.replace(/\.[^.]+$/, "");
    const noExt = p.replace(/\.[^.]+$/, "");
    if (stem === baseName || extras.some((extra) => stem === baseName + extra)) return true;
    if (p.endsWith(`/${baseName}/index.ts`) || p.endsWith(`/${baseName}/__init__.py`)) return true;
    return noExt.endsWith(`/${trimmed}`) || noExt.endsWith(`/src/${trimmed}`);
  });
  if (matches.length === 0) return undefined;
  const fromDir = posix(fromFile).split("/").slice(0, -1).join("/");
  matches.sort((a, b) => {
    const aNear = posix(a).startsWith(fromDir) ? 0 : 1;
    const bNear = posix(b).startsWith(fromDir) ? 0 : 1;
    return aNear - bNear || depth(a) - depth(b) || a.localeCompare(b);
  });
  return matches[0];
}

export function hopTargetsFromSource(
  fromFile: string,
  source: string,
  listedFiles: readonly string[],
): { paths: string[]; searchTerms: string[]; clientSearchTerms: string[]; unresolvedSpecs: string[] } {
  const paths = new Set<string>();
  const searchTerms = new Set<string>();
  const clientSearchTerms = new Set<string>();
  const unresolvedSpecs: string[] = [];

  for (const spec of extractModuleSpecifiers(source)) {
    const resolved = resolveImport(fromFile, spec, listedFiles);
    if (resolved && !isSkipTracePath(resolved)) paths.add(resolved);
    else {
      if (!isExternalModuleSpecifier(spec, listedFiles) && (isClientLikeSpecifier(spec) || spec.startsWith(".") || spec.startsWith("@/") || spec.includes("/"))) {
        unresolvedSpecs.push(spec);
      }
      const last = spec.split("/").pop();
      if (last && last.length >= 3 && last !== "index") {
        const term = last.replace(/\.[a-z0-9]+$/i, "");
        searchTerms.add(term);
        if (isClientLikeSpecifier(spec)) clientSearchTerms.add(term);
      }
    }
  }
  const imported = extractImportedBindings(source);
  for (const name of imported) searchTerms.add(name);
  for (const match of source.matchAll(/\bmod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g)) {
    const resolved = resolveImport(fromFile, `./${match[1]}`, listedFiles);
    if (resolved && !isSkipTracePath(resolved)) paths.add(resolved);
  }
  for (const match of source.matchAll(/\buse\s+crate::([A-Za-z_][\w:]*)/g)) {
    const head = match[1]!.split("::")[0];
    if (!head) continue;
    const resolved = resolveImport(fromFile, `./${head}`, listedFiles);
    if (resolved && !isSkipTracePath(resolved)) paths.add(resolved);
    else searchTerms.add(head);
  }
  for (const name of extractCallNames(source)) {
    searchTerms.add(name);
  }
  for (const name of extractHookNames(source)) {
    searchTerms.add(name);
    clientSearchTerms.add(name);
  }
  for (const hint of extractEndpointHints(source)) {
    searchTerms.add(hint);
  }
  const prioritized = [...imported, ...clientSearchTerms];
  const rest = [...searchTerms].filter((term) => !prioritized.includes(term));
  return {
    paths: [...paths].sort((a, b) => hopPathPriority(a) - hopPathPriority(b)),
    searchTerms: [...prioritized, ...rest].slice(0, 12),
    clientSearchTerms: [...clientSearchTerms].slice(0, 6),
    unresolvedSpecs,
  };
}

/** Prefer API/state modules over chrome when the file budget is tight. */
export function hopPathPriority(path: string): number {
  if (looksLikeClientPath(path)) return 0;
  if (/(hook|slice|thunk|store|api|service)/i.test(path)) return 1;
  if (README_RE.test(posix(path)) || DOC_RE.test(posix(path)) || MANIFEST_RE.test(posix(path))) return 5;
  return 3;
}

export function traceFilePriority(path: string, snippet: string, keywords: readonly string[]): number {
  const p = posix(path);
  if (isLockfile(p) || STYLE_LAYOUT_RE.test(p)) return -100;
  let score = 0;
  if (README_RE.test(p) || (DOC_RE.test(p) && /\.md$/i.test(p))) score -= 40;
  if (MANIFEST_RE.test(p)) score -= 30;
  if (extractHttpCalls(snippet).length > 0) score += 35;
  if (looksLikeClientPath(p)) score += 25;
  if (/(hook|slice|thunk|store|api|service)/i.test(p)) score += 15;
  for (const kw of keywords) {
    if (p.toLowerCase().includes(kw)) score += 10;
    if (snippet.toLowerCase().includes(kw)) score += 4;
  }
  return score;
}

export interface HopPickOptions {
  /** When searching for a route, skip frontend API-client hits. */
  preferBackend?: boolean;
  /** When searching for a referenced client/hook, prefer those files. */
  preferClient?: boolean;
}

function looksLikeDefinition(term: string, text: string | undefined): boolean {
  if (!text) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(String.raw`\bexport\b[\s\S]{0,120}\b${escaped}\b`).test(text);
}

/** Choose the next file to read from search hits for a hop term. */
export function pickHopFromMatches(
  term: string,
  matches: { path: string; text?: string }[],
  listedFiles: readonly string[],
  already: ReadonlySet<string>,
  options?: HopPickOptions,
): string | undefined {
  const listed = new Set(listedFiles.map(posix));
  const needle = term.toLowerCase().replace(/^\//, "");
  let ranked = matches
    .map((m) => ({ path: posix(m.path), text: m.text }))
    .filter((m) => !already.has(m.path) && !isSkipTracePath(m.path) && (listed.size === 0 || listed.has(m.path)));
  if (options?.preferBackend) {
    const backendish = ranked.filter((m) => looksLikeBackendPath(m.path));
    ranked = backendish.length > 0 ? backendish : ranked.filter((m) => !looksLikeFrontendPath(m.path));
  } else if (options?.preferClient) {
    const clientish = ranked.filter((m) => looksLikeClientPath(m.path) || looksLikeFrontendPath(m.path));
    if (clientish.length > 0) ranked = clientish.filter((m) => !looksLikeBackendPath(m.path));
  }
  if (ranked.length === 0) return undefined;
  ranked.sort((a, b) => {
    const aDef = looksLikeDefinition(term, a.text) ? 0 : 1;
    const bDef = looksLikeDefinition(term, b.text) ? 0 : 1;
    const aBack = looksLikeBackendPath(a.path) ? 0 : 1;
    const bBack = looksLikeBackendPath(b.path) ? 0 : 1;
    const aName = a.path.toLowerCase().includes(needle) ? 0 : 1;
    const bName = b.path.toLowerCase().includes(needle) ? 0 : 1;
    return aDef - bDef || aBack - bBack || aName - bName || depth(a.path) - depth(b.path) || a.path.localeCompare(b.path);
  });
  return ranked[0]?.path;
}

export interface HttpCallHint {
  method?: string;
  path?: string;
  hasRequestPayload?: boolean;
  hasResponseHandling?: boolean;
}

export type TraceRole = "ui" | "hook" | "state" | "client" | "backend" | "other";

export type RetrievalGapKind = "not_in_repository" | "unreadable" | "not_retrieved" | "omitted_for_limit";

export interface RetrievalGap {
  kind: RetrievalGapKind;
  path?: string;
  specifier?: string;
}

function listedFileForUnresolvedSpec(spec: string, listedFiles: readonly string[]): string | undefined {
  const fromPlaceholder = resolveImport("src/_placeholder.ts", spec, listedFiles);
  if (fromPlaceholder) return fromPlaceholder;
  const p = posix(spec).replace(/^@\/?/, "");
  return listedFiles.find((file) => {
    const noExt = posix(file).replace(/\.[^.]+$/, "");
    return noExt.endsWith(`/${p}`) || noExt === p;
  });
}

function retrievedCoversSpecifier(spec: string, retrieved: ReadonlySet<string>): boolean {
  const last = posix(spec).split("/").pop()?.replace(/\.[a-z0-9]+$/i, "") ?? "";
  if (last.length < 2) return false;
  for (const file of retrieved) {
    const stem = posix(file).split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
    if (stem === last) return true;
    if (stem.startsWith(last) && /^(Items|Item|Api|Client|Service|Slice|Store|Actions|Hook|s)$/i.test(stem.slice(last.length))) {
      return true;
    }
  }
  return false;
}

/** Map a failed import to a gap, or undefined when it is external / already covered. */
export function classifyUnresolvedSpecifier(
  spec: string,
  listedFiles: readonly string[],
  retrieved: ReadonlySet<string>,
  unreadable: ReadonlySet<string>,
): RetrievalGap | undefined {
  if (isExternalModuleSpecifier(spec, listedFiles)) return undefined;
  if (retrievedCoversSpecifier(spec, retrieved)) return undefined;
  const listedMatch = listedFileForUnresolvedSpec(spec, listedFiles);
  if (listedMatch && retrieved.has(listedMatch)) return undefined;
  if (listedMatch && unreadable.has(listedMatch)) return undefined;
  if (listedMatch) return { kind: "not_retrieved", path: listedMatch, specifier: spec };
  return { kind: "not_in_repository", specifier: spec };
}

/** User-facing / note-worthy gaps — skip omitted layout chrome. */
export function isRelevantRetrievalGap(gap: RetrievalGap): boolean {
  if (gap.kind === "not_in_repository") return true;
  if (gap.kind === "unreadable") return true;
  const path = gap.path;
  if (!path) return true;
  if (isSkipTracePath(path)) return false;
  return hopPathPriority(path) <= 1 || looksLikeBackendImplementation(path);
}

export interface RepoShape {
  languages: string[];
  configFiles: string[];
  frameworks: string[];
  treeSuggestsUi: boolean;
  treeSuggestsServer: boolean;
}

export interface TraceSummary {
  files: { path: string; role: TraceRole }[];
  httpCalls: HttpCallHint[];
  backendFound: boolean;
  backendSearched: boolean;
  shape?: RepoShape;
  gaps: RetrievalGap[];
}

const HTTP_METHODS = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS";

/** HTTP method + path strings from client or route source (not invented). */
export function extractHttpCalls(source: string): HttpCallHint[] {
  const out: HttpCallHint[] = [];
  const add = (method?: string, rawPath?: string): void => {
    const normalizedMethod = method ? method.toUpperCase() : undefined;
    const path = rawPath?.trim();
    if (!normalizedMethod && !path) return;
    if (path?.startsWith("//")) return;
    if (out.some((item) => item.method === normalizedMethod && item.path === path)) return;
    out.push({ method: normalizedMethod, path });
  };

  for (const match of source.matchAll(
    /\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
  )) {
    add(match[1], match[2]);
  }
  for (const match of source.matchAll(/\bfetch\s*\(\s*["'`]([^"'`]+)["'`]/gi)) {
    add(undefined, match[1]);
  }
  for (const match of source.matchAll(
    new RegExp(String.raw`\bmethod\s*:\s*["'\`](${HTTP_METHODS})["'\`]`, "gi"),
  )) {
    add(match[1], undefined);
  }
  for (const match of source.matchAll(/\bhttp_(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/gi)) {
    add(match[1], match[2]);
  }
  for (const match of source.matchAll(/@(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/gi)) {
    add(match[1], match[2]);
  }
  for (const match of source.matchAll(/\bHandleFunc\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
    add(undefined, match[1]);
  }

  const methodOnly = out.filter((item) => item.method && !item.path);
  const pathOnly = out.filter((item) => item.path && !item.method);
  if (methodOnly.length === 1 && pathOnly.length > 0) {
    const method = methodOnly[0]!.method;
    for (const item of pathOnly) item.method = method;
  }

  const hasPayloadHint =
    /\bbody\s*:/.test(source) || /\.\s*(post|put|patch)\s*\(\s*["'`][^"'`]+["'`]\s*,/.test(source);
  const hasResponseHint = /\.json\s*\(|\bresponse\.data\b/.test(source);
  const finalized = methodOnly.length === 1 && pathOnly.length > 0 ? out.filter((item) => item.path) : out;
  for (const item of finalized) {
    if (hasPayloadHint) item.hasRequestPayload = true;
    if (hasResponseHint) item.hasResponseHandling = true;
  }
  return finalized;
}

export function looksLikeFrontendPath(path: string): boolean {
  const p = posix(path);
  if (/\.(tsx|jsx|vue|svelte)$/i.test(p)) return true;
  return /(^|\/)(pages?|components?|views?|screens?|store|redux|pinia|frontend|client|web|ui|hooks?)\//i.test(p);
}

function looksLikeBackendPath(path: string): boolean {
  const p = posix(path);
  if (looksLikeFrontendPath(p) && !/(^|\/)(app|pages)\/api\//i.test(p)) return false;
  return (
    /(^|\/)(app|pages)\/api\//i.test(p) ||
    /(^|\/)(backend|server|svc|internal|cmd)\//i.test(p) ||
    /\/(routes?|controllers?|handlers?)\//i.test(p) ||
    /(^|\/)[^/]*(routes?|controllers?|handlers?)[^/]*\.[a-z0-9]+$/i.test(p) ||
    /_(controller|handler|route)s?\.[a-z0-9]+$/i.test(p)
  );
}

/**
 * True when a listed file is a server route/controller — not a frontend API client.
 */
export function looksLikeBackendImplementation(path: string, source?: string): boolean {
  const p = posix(path);
  if (isSkipTracePath(p)) return false;
  const pathHit = looksLikeBackendPath(p);
  if (!source) return pathHit;

  const srcHit =
    /\b(?:router|app|server)\s*\.\s*(get|post|put|patch|delete|use)\s*\(/i.test(source) ||
    /@(?:app|router)\.(get|post|put|patch|delete)\s*\(/i.test(source) ||
    /@(Get|Post|Put|Patch|Delete|Controller|GetMapping|PostMapping|RequestMapping|RestController)\b/.test(
      source,
    ) ||
    /\bhttp\.(HandleFunc|Handle|ListenAndServe)\b/.test(source) ||
    /#\[(?:get|post|put|patch|delete|route)\s*\(/i.test(source);

  const clientOnly =
    !pathHit &&
    /\b(?:axios|fetch|api)\b/i.test(source) &&
    !/\b(?:router|app|server)\s*\.\s*(get|post|put|patch|delete|use)\s*\(/i.test(source) &&
    !/@(?:app|router)\.(get|post|put|patch|delete)\s*\(/i.test(source);

  if (clientOnly) return false;
  return pathHit || srcHit;
}

export function classifyTraceRole(path: string, source: string): TraceRole {
  if (looksLikeBackendImplementation(path, source)) return "backend";
  const p = posix(path);
  if (/(^|\/)hooks?\//i.test(p) || /\/use[A-Z][A-Za-z0-9]+\.[a-z0-9]+$/.test(p)) return "hook";
  if (
    /(slice|store|thunk|redux|reducer|pinia|vuex|zustand|mobx)/i.test(p) ||
    /\b(defineStore|createSlice|createStore|configureStore)\s*\(/.test(source)
  ) {
    return "state";
  }
  if (extractHttpCalls(source).length > 0 || /(^|\/)api\/|api\.[a-z0-9]+$/i.test(p)) return "client";
  if (looksLikeFrontendPath(p)) return "ui";
  return "other";
}

const EXT_LANGUAGE: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  go: "Go",
  rs: "Rust",
  java: "Java",
  kt: "Kotlin",
  vue: "Vue",
  svelte: "Svelte",
  rb: "Ruby",
  php: "PHP",
  cs: "C#",
  swift: "Swift",
};

const MANIFEST_HINTS: { file: RegExp; label: string }[] = [
  { file: /(^|\/)package\.json$/i, label: "package.json" },
  { file: /(^|\/)go\.mod$/i, label: "go.mod" },
  { file: /(^|\/)cargo\.toml$/i, label: "Cargo.toml" },
  { file: /(^|\/)pyproject\.toml$/i, label: "pyproject.toml" },
  { file: /(^|\/)composer\.json$/i, label: "composer.json" },
  { file: /(^|\/)gemfile$/i, label: "Gemfile" },
  { file: /(^|\/)(next|vite|nuxt|angular)\.config\.[a-z0-9]+$/i, label: "bundler config" },
];

const FRAMEWORK_HINTS = [
  "react",
  "vue",
  "angular",
  "svelte",
  "next",
  "nuxt",
  "express",
  "fastify",
  "django",
  "flask",
  "fastapi",
  "rails",
  "laravel",
  "spring",
  "gin",
  "axum",
  "actix",
];

/** Languages, config files, and UI/server hints from the listed tree — no assumed layout. */
export function inferRepoShape(listedFiles: readonly string[]): RepoShape {
  const languages = new Set<string>();
  const configFiles: string[] = [];
  let treeSuggestsUi = false;
  let treeSuggestsServer = false;
  for (const file of listedFiles) {
    const p = posix(file);
    const ext = p.split(".").pop()?.toLowerCase();
    if (ext && EXT_LANGUAGE[ext]) languages.add(EXT_LANGUAGE[ext]);
    if (MANIFEST_HINTS.some((hint) => hint.file.test(p))) configFiles.push(p);
    if (looksLikeFrontendPath(p)) treeSuggestsUi = true;
    if (looksLikeBackendPath(p)) treeSuggestsServer = true;
  }
  return {
    languages: [...languages].sort(),
    configFiles: configFiles.slice(0, 8),
    frameworks: [],
    treeSuggestsUi,
    treeSuggestsServer,
  };
}

export function inferFrameworksFromSource(path: string, source: string): string[] {
  if (!MANIFEST_HINTS.some((hint) => hint.file.test(posix(path)))) return [];
  const lower = source.toLowerCase();
  return FRAMEWORK_HINTS.filter((name) => lower.includes(`"${name}"`) || lower.includes(`'${name}'`));
}

export function summarizeTrace(
  files: { path: string; snippet: string }[],
  backendSearched: boolean,
  listedFiles: readonly string[] = [],
  gaps: RetrievalGap[] = [],
): TraceSummary {
  const roles = files.map((file) => ({
    path: file.path,
    role: classifyTraceRole(file.path, file.snippet),
  }));
  const httpCalls: HttpCallHint[] = [];
  const frameworks = new Set<string>();
  for (const file of files) {
    for (const name of inferFrameworksFromSource(file.path, file.snippet)) frameworks.add(name);
    if (looksLikeBackendImplementation(file.path, file.snippet)) continue;
    for (const call of extractHttpCalls(file.snippet)) {
      if (!httpCalls.some((item) => item.method === call.method && item.path === call.path)) {
        httpCalls.push(call);
      }
    }
  }
  const shape = listedFiles.length > 0 ? inferRepoShape(listedFiles) : undefined;
  if (shape) shape.frameworks = [...frameworks].sort();
  return {
    files: roles,
    httpCalls,
    backendFound: roles.some((file) => file.role === "backend"),
    backendSearched,
    shape,
    gaps,
  };
}

export function formatTraceNotes(summary: TraceSummary): string {
  const lines = [
    "Use only these claim kinds: verified (CONTEXT shows it), inference (label it and cite evidence),",
    "external (not in the connected repository), or unknown (still unknown after these searches).",
    "Do not assume Redux, Express, or any folder layout unless those appear in CONTEXT.",
  ];
  if (summary.shape) {
    const langs = summary.shape.languages.length > 0 ? summary.shape.languages.join(", ") : "undetermined";
    lines.push(`Observed from the connected file tree (not assumed): languages: ${langs}.`);
    lines.push(
      `UI-like paths present: ${summary.shape.treeSuggestsUi ? "yes" : "no"}; server-like paths present: ${summary.shape.treeSuggestsServer ? "yes" : "no"}.`,
    );
    if (summary.shape.frameworks.length > 0) {
      lines.push(`Framework names found in retrieved manifests: ${summary.shape.frameworks.join(", ")}.`);
    }
  }
  lines.push("Verified files retrieved (roles inferred from path/source, not assumed):");
  if (summary.files.length === 0) {
    lines.push("(none retrieved after searching the connected repository)");
    lines.push("The implementation cannot be determined from the available code. Do not invent files, functions, or endpoints.");
    return lines.join("\n");
  }
  for (const file of summary.files) {
    lines.push(`- ${file.role}: ${file.path}`);
  }
  if (summary.httpCalls.length > 0) {
    lines.push("HTTP calls found in retrieved client or action code (only fields the source supports):");
    for (const call of summary.httpCalls) {
      const method = call.method ?? "(method cannot be determined from the available code)";
      const path = call.path ?? "(path cannot be determined from the available code)";
      const extras: string[] = [];
      if (call.hasRequestPayload) extras.push("request payload appears in source");
      if (call.hasResponseHandling) extras.push("response handling appears in source");
      lines.push(`- ${method} ${path}${extras.length > 0 ? ` (${extras.join("; ")})` : ""}`);
    }
  }
  const visibleGaps = summary.gaps.filter(isRelevantRetrievalGap);
  if (visibleGaps.length > 0) {
    lines.push("Retrieval gaps (do not treat these as verified source):");
    for (const gap of visibleGaps) {
      const target = gap.path ?? gap.specifier ?? "a referenced module";
      if (gap.kind === "unreadable") {
        lines.push(`- ${target} is listed in the repository but could not be retrieved or inspected.`);
      } else if (gap.kind === "omitted_for_limit") {
        lines.push(`- ${target} exists but was omitted because the context file or size limit was reached.`);
      } else if (gap.kind === "not_retrieved") {
        lines.push(`- ${target} exists in the listing but was not retrieved (context limit).`);
      } else {
        lines.push(`- ${target} was not found in the repository.`);
      }
    }
  }
  const backendUnverified = summary.gaps.some(
    (gap) =>
      Boolean(gap.path) &&
      looksLikeBackendImplementation(gap.path!) &&
      gap.kind !== "not_in_repository",
  );
  if (summary.backendFound) {
    lines.push("A matching backend route/controller was retrieved. Describe only what those files show.");
  } else if (backendUnverified) {
    lines.push("A server-like file was listed but was not included in CONTEXT. Do not invent backend behavior.");
    lines.push("Server-side HTTP details cannot be determined from the available code.");
  } else if (summary.httpCalls.length > 0) {
    lines.push("The repository contains no matching backend implementation.");
    lines.push(
      "The frontend calls an external API whose server implementation cannot be verified from this repository.",
    );
    lines.push("Do not invent route/controller files or backend behavior.");
  } else if (!summary.shape?.treeSuggestsServer) {
    lines.push("No server-like paths appear in the connected file tree. Do not invent a backend.");
  } else {
    lines.push("Server-side HTTP details cannot be determined from the available code.");
  }
  return lines.join("\n");
}

export const NO_BACKEND_IMPLEMENTATION =
  "The repository contains no matching backend implementation. The frontend calls an external API whose server implementation cannot be verified from this repository.";

export const INSUFFICIENT_CONTEXT =
  "The implementation cannot be determined from the available code.";

export const UNREADABLE_FILE =
  "A referenced source file is listed in the repository but could not be retrieved or inspected.";

export const NOT_IN_REPOSITORY = "A referenced module was not found in the repository.";

export const OMITTED_FOR_LIMIT =
  "A relevant source file exists but was omitted because the context file or size limit was reached.";

export function applyTraceGrounding(answer: string, summary: TraceSummary | undefined): string {
  let text = answer.trim();
  if (!summary) return text;
  if (summary.files.length === 0) {
    if (/cannot be determined from the available code/i.test(text)) return text;
    return text ? `${text}\n\n${INSUFFICIENT_CONTEXT}` : INSUFFICIENT_CONTEXT;
  }
  const gaps = summary.gaps.filter(isRelevantRetrievalGap);
  if (gaps.some((gap) => gap.kind === "unreadable") && !/could not be retrieved or inspected/i.test(text)) {
    text = text ? `${text}\n\n${UNREADABLE_FILE}` : UNREADABLE_FILE;
  }
  if (gaps.some((gap) => gap.kind === "not_in_repository") && !/was not found in the repository/i.test(text)) {
    text = text ? `${text}\n\n${NOT_IN_REPOSITORY}` : NOT_IN_REPOSITORY;
  }
  if (
    gaps.some((gap) => gap.kind === "omitted_for_limit" || gap.kind === "not_retrieved") &&
    !/omitted because the context/i.test(text) &&
    !/was not retrieved/i.test(text)
  ) {
    text = text ? `${text}\n\n${OMITTED_FOR_LIMIT}` : OMITTED_FOR_LIMIT;
  }
  const backendUnverified = summary.gaps.some(
    (gap) =>
      Boolean(gap.path) &&
      looksLikeBackendImplementation(gap.path!) &&
      gap.kind !== "not_in_repository",
  );
  if (summary.backendFound || summary.httpCalls.length === 0 || backendUnverified) return text;
  if (/no matching backend implementation/i.test(text) || /cannot be verified from this repository/i.test(text)) {
    return text;
  }
  return `${text}\n\n${NO_BACKEND_IMPLEMENTATION}`;
}
