# RepoPilot — Project Description

Use this document when you need a professional summary of the product: what it does, which technologies and skills it uses, how it is structured, and where it is intended to run.

**One-line pitch:** RepoPilot is an AI repository navigator. Paste a GitHub URL, explore the code, and ask questions that are answered from real files in that repository.

---

## 1. Problem and solution

Unfamiliar repositories are hard to onboard onto. Developers jump between README files, folder trees, and search, and still miss how a feature actually works.

RepoPilot shortens that path:

1. The user pastes a public GitHub URL (or a private repo URL plus their own GitHub token).
2. The backend downloads the repository archive, extracts it safely, and opens a short-lived session.
3. The UI shows repository metadata, a file list, search, and a file viewer.
4. The Ask panel answers natural-language questions using repository context retrieved through an MCP server, then Google Gemini. Citations are checked against files that were actually read.

Browsing works without an AI key. Ask requires `GEMINI_API_KEY` on the **backend only**.

---

## 2. What you can say in 30 seconds

> RepoPilot is a full-stack TypeScript monorepo. A React + Vite frontend talks to an Express API. The API clones nothing with `git`; it downloads a GitHub tarball, extracts it with safety limits, and explores the files through a real Model Context Protocol (MCP) server over stdio. Optional Google Gemini answers are grounded in that MCP context, not in invented files. The UI is on Vercel (https://repopilot-swart.vercel.app) and the API is on Render (https://repopilot-sjux.onrender.com).

---

## 3. Technology stack

### Frontend (`apps/web`)

| Area | What we used | Why |
| ---- | ------------ | --- |
| UI library | **React 19** | Component-based explorer, connect form, and Ask panel |
| Language | **TypeScript** (strict) | Typed API client, session state, and props |
| Bundler / dev server | **Vite 8** | Fast local dev; production build to `apps/web/dist` |
| Styling | **`index.css`** (plain CSS, no CSS-in-JS) | Shared layout, dark theme, mobile breakpoints at 680px / 420px |
| HTTP | Custom **`apiClient`** | Talks to `/api/*`; Vite proxies that path to the API in development |
| Testing | **Vitest** + React Testing Library style component tests | Connect-form behaviour |
| Hosting target | **Vercel** (static Vite output) | SPA rewrite to `index.html` via `vercel.json` |

**Frontend building blocks**

| File | Role |
| ---- | ---- |
| `pages/HomePage.tsx` | Page state: API health, connect / disconnect, which view to show |
| `components/ConnectRepositoryForm.tsx` | URL + optional PAT, private-token security notice, errors |
| `components/RepositoryCard.tsx` | Connected repo name, branch, file count, session expiry |
| `components/RepositoryExplorer.tsx` | File list, search, selected file, Ask panel |
| `components/AskPanel.tsx` | Question form, grounded answer, clickable sources |
| `components/FileViewer.tsx` | Line-numbered read-only source view |
| `components/StatusBadge.tsx` | API online / offline / loading |
| `services/apiClient.ts` | REST calls; no secrets in the bundle |
| `types/api.ts` | Shared frontend types for API responses |

The frontend does **not** hold `GEMINI_API_KEY` or persist a GitHub token.

### Backend (`apps/api`)

| Area | What we used | Why |
| ---- | ------------ | --- |
| Runtime | **Node.js 22+** | Long-lived process (required for MCP child + disk) |
| Framework | **Express 5** | REST under `/api`, plus `GET /health` |
| Language | **TypeScript** (ES modules, NodeNext) | Strict types; `.js` extensions on relative imports |
| Security headers | **Helmet** | Baseline HTTP hardening |
| CORS | **`cors`** | Allow-list of `WEB_ORIGIN` only |
| Archives | **`tar`** (library, not a shell) | Safe extract of the GitHub tarball |
| AI SDK | **`@google/genai`** | Isolated in `geminiClient.ts` |
| MCP client | **official TypeScript MCP SDK** | Spawns `packages/mcp-server` over stdio |
| Testing | **Vitest** + **Supertest** | Routes, retrieval, AI orchestration, MCP client |
| Hosting target | **Render** (Node web service) | Needs process + writable disk + child process |

**Backend building blocks**

| Path | Role |
| ---- | ---- |
| `routes/` | Thin HTTP handlers; errors go to `next(error)` |
| `services/githubService.ts` | GitHub metadata + tarball download |
| `services/sessionStore.ts` | In-memory sessions with TTL cleanup |
| `services/mcpClient.ts` | Spawn MCP server; map tool results to HTTP |
| `services/contextRetrieval.ts` | Generic import/hop retrieval for Ask |
| `services/aiService.ts` | Prompt, rate limit, citation clamp |
| `services/geminiClient.ts` | Only place the Gemini SDK is called |
| `middleware/rateLimit.ts` | Per-IP limits on connect/browse |
| `utils/githubUrl.ts`, `githubToken.ts`, `repoFiles.ts` | Validation and extract safety |

The API never imports MCP tool functions directly. File access for browse **and** Ask goes through the MCP child process.

### MCP server (`packages/mcp-server`)

| Area | What we used | Why |
| ---- | ------------ | --- |
| Protocol | **Model Context Protocol** (official TS SDK) | Standard tool interface over stdio |
| Validation | **Zod** | Tool input schemas |
| Transport | **stdio** | API is the client; stdout is reserved for MCP frames (`console.error` for logs) |

**Tools** (one file each, registered in `src/server.ts`)

| Tool | Purpose |
| ---- | ------- |
| `list_project_files` | List files under a session workspace |
| `search_project_code` | Search file contents |
| `read_project_file` | Read a file (path-safe, size-capped) |

Shared path safety lives in `src/lib`. Tools return `{ ok, data }` or `{ ok, status, error }`. They never execute repository code.

### AI

| Item | Detail |
| ---- | ------ |
| Provider | Google Gemini (`GEMINI_API_KEY` optional, backend only) |
| Default model | Configurable (`GEMINI_MODEL`) |
| Grounding | Context is gathered through MCP list/search/read, not by the model browsing disk |
| Safety | Repository text is treated as untrusted data, not instructions; citations are validated against retrieved files |

If the key is unset, connect/browse still work. Ask returns a clear unavailable error.

---

## 4. Repository structure

This is an **npm workspaces** monorepo.

| Path | Responsibility |
| ---- | -------------- |
| `apps/web` | React + TypeScript + Vite UI |
| `apps/api` | Express REST API and AI orchestration |
| `packages/mcp-server` | Read-only MCP tools |
| `docs/` | Design and this project description |
| `.cursor/rules/` | Persistent Cursor coding conventions |
| `.cursor/skills/` | Agent skill for safe repo exploration |
| `.cursor/hooks.json` + `.cursor/hooks/` | Cursor automation (deploy/env guards) |
| `.github/workflows/check.yml` | CI on push/PR |
| `DEPLOY.md` | First-time Vercel + Render checklist |
| `AGENTS.md` | Instructions for AI coding agents |
| `README.md` | How to run the project locally |

**Request flow**

```
Browser (React)
  → apps/api REST
      → browse: MCP client spawns packages/mcp-server (stdio) → read-only file ops
      → ask:    same MCP path for context → Gemini → validated sources
```

---

## 5. Documentation, Cursor rules, skills, and hooks

These are first-class parts of the project, not leftover editor config.

| Artifact | What it is | What to say |
| -------- | ---------- | ----------- |
| `README.md` | User-facing setup and API table | How to install, run, and troubleshoot |
| `docs/SYSTEM_DESIGN.md` | Architecture, API surface, safety, intended hosting | Design document |
| `docs/PROJECT_DESCRIPTION.md` | This file | Stack, skills, and deployment summary |
| `DEPLOY.md` | Render + Vercel field checklist | How to publish when ready |
| `AGENTS.md` | Agent operating manual | Conventions, MCP/Gemini boundaries, commands |
| `.cursor/rules/repopilot-conventions.mdc` | Persistent Cursor rule | Keeps agents aligned with repo conventions |
| `.cursor/skills/repo-exploration/SKILL.md` | Cursor Agent Skill | Systematic explore / safe-change workflow |
| `.cursor/hooks.json` | Cursor hooks (schema v1) | Cheap Node hooks; fail open on errors |

**Cursor hooks**

| Event | Script | Behaviour |
| ----- | ------ | --------- |
| `beforeShellExecution` | `.cursor/hooks/guard-deploy.mjs` | Asks before `vercel` / `netlify` / `render deploy` / `git push` / `npm publish` |
| `preToolUse` (`Write` / `StrReplace`) | `.cursor/hooks/guard-env-write.mjs` | Asks before editing a real `.env` (not `.env.example`) |

Offline check: `npm run verify:hooks`.

---

## 6. Quality, CI, and engineering practices

| Practice | Implementation |
| -------- | -------------- |
| Monorepo | npm workspaces (`apps/*`, `packages/*`) |
| Language | TypeScript strict mode; `unknown` instead of `any`; `import type` |
| Tests | Vitest in each package (`apps/api/tests`, `apps/web/tests`, `packages/mcp-server/tests`) |
| Lint | ESLint (TypeScript + React hooks) |
| One command | `npm run check` = typecheck + lint + test + build |
| CI | GitHub Actions (`.github/workflows/check.yml`) on push/PR to `main` or `master` |
| Secrets | Real values only in git-ignored `.env`; placeholders in `.env.example` |

A push to GitHub runs **CI**, not a production deploy, until Vercel and Render are connected to the repository.

---

## 7. Security highlights (for judges / reviews)

- GitHub tarball download — no `git` binary, no shell, no install hooks.
- Extract rejects `..` traversal, symlinks/hardlinks, and common secret/build paths.
- Repository code is **read only**. It is never executed.
- Per-request private-repo PAT is request-scoped: not stored, not logged, not sent to MCP or Gemini.
- Server `GITHUB_TOKEN` is only a public rate-limit helper and is **not** used to open private repos.
- CORS allow-list; Helmet; per-IP rate limits; Ask has its own per-session limit.
- Gemini key stays on the API. The frontend bundle never contains it.

Private-repository support is an **MVP**. Treat it as such unless a security review has been done.

---

## 8. Deployment

### Live URLs

| Piece | Host | URL |
| ----- | ---- | --- |
| Frontend | Vercel | https://repopilot-swart.vercel.app |
| Backend API | Render | https://repopilot-sjux.onrender.com |
| Source | GitHub | https://github.com/abhishek22809/repopilot |

Checked on 24 Oct 2026: the frontend returned HTTP 200; `GET /health` and `GET /api/health` on Render returned `{ "status": "ok" }`; CORS `Access-Control-Allow-Origin` is `https://repopilot-swart.vercel.app`; the Vercel JS bundle includes `repopilot-sjux.onrender.com` (`VITE_API_BASE_URL`). A full connect → browse → Ask (live Gemini) pass on production is **not** claimed here.

| Item | Status |
| ---- | ------ |
| Local run | `npm run dev` — web `:5173`, API `:4000` |
| CI on push | Yes — `npm run check` and `npm run verify:hooks` |
| Auto-deploy | After these hosts are linked to GitHub, a push to the connected branch rebuilds them |

### Production split

The API cannot run as a Vercel serverless function. It needs a long-lived Node process, a writable disk for extracted repos, and a stdio child for MCP.

| Piece | Host | Build / start | Required env (names only) |
| ----- | ---- | ------------- | ------------------------- |
| Frontend (`apps/web`) | **Vercel** (static) | `npm run build:web` → `apps/web/dist` | `VITE_API_BASE_URL=https://repopilot-sjux.onrender.com` (baked in at **build** time) |
| API + MCP | **Render** (Node 22 web service) | Build `npm install && npm run build:backend`; start `npm start` | `NODE_ENV=production`, `WEB_ORIGIN=https://repopilot-swart.vercel.app`, `TRUST_PROXY=1`; optional `GEMINI_API_KEY` |

Field-by-field checklist: **[DEPLOY.md](../DEPLOY.md)**. Architecture notes: **[SYSTEM_DESIGN.md](./SYSTEM_DESIGN.md)**.

Do not put `GEMINI_API_KEY` or GitHub tokens on Vercel.

---

## 9. Skills this project demonstrates

Use this list on a hackathon form, resume, or oral presentation.

**Frontend**

- React 19 component design (page + focused presentational components)
- TypeScript in the UI
- Vite toolchain
- REST client and loading / error / empty states
- Responsive CSS (desktop two-column explorer, stacked mobile layout)
- Accessibility basics (labels, `role="alert"`, token notice)

**Backend**

- Express 5 REST API design
- Service-layer architecture (thin routes)
- Session lifecycle and cleanup
- GitHub API + streaming download + safe archive extract
- Rate limiting and CORS
- Error mapping without leaking filesystem paths or tokens

**AI / MCP**

- Official MCP TypeScript SDK (server + client)
- Tool design with Zod
- Retrieval-augmented questions with citation validation
- Prompt isolation (untrusted repo text vs system instructions)

**Platform and process**

- npm workspaces monorepo
- GitHub Actions CI
- Deployment split (static frontend / long-lived API)
- Agent-ready repo: `AGENTS.md`, Cursor rules, skills, and hooks

---

## 10. Copy-paste snippets

### Short abstract (≈80 words)

RepoPilot is an AI Repository Navigator built as a TypeScript monorepo. A React + Vite frontend lets a user paste a GitHub URL, browse files, search code, and ask questions. An Express API downloads the GitHub tarball (no `git` clone), extracts it with path and size guards, and explores the tree through a read-only MCP server over stdio. Optional Google Gemini answers are grounded in that retrieved context. The UI is on Vercel (`https://repopilot-swart.vercel.app`); the API is on Render (`https://repopilot-sjux.onrender.com`).

### Tech stack (comma-separated)

React 19, TypeScript, Vite, CSS, Node.js, Express 5, Model Context Protocol (MCP), Zod, Google Gemini, Vitest, ESLint, npm workspaces, GitHub Actions, Vercel, Render, Cursor hooks and skills

### Local demo

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

Open `http://localhost:5173`. Add `GEMINI_API_KEY` in `.env` only if you want to demo Ask.

---

## Related files

| Need | Open |
| ---- | ---- |
| How to run | [README.md](../README.md) |
| Architecture | [SYSTEM_DESIGN.md](./SYSTEM_DESIGN.md) |
| How to publish | [DEPLOY.md](../DEPLOY.md) |
| Agent / code conventions | [AGENTS.md](../AGENTS.md) |
