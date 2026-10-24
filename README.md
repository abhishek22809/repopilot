# RepoPilot — AI Repository Navigator

Paste a GitHub repository URL and let RepoPilot help you explore and understand it.

For a professional project write-up (frontend/backend stack, MCP, Cursor hooks and skills, CI, and intended deployment), see **[docs/PROJECT_DESCRIPTION.md](docs/PROJECT_DESCRIPTION.md)**.

> Status: Optional per-request GitHub token for **authorized private repositories**, plus the existing public-repo, MCP, and Ask flows. **Private-repo support is an MVP — not production-ready without a security review.** Live Gemini answering remains **NOT VERIFIED** unless you have exercised it yourself.

**Live app:** [frontend (Vercel)](https://repopilot-swart.vercel.app) · [API (Render)](https://repopilot-sjux.onrender.com/health)

## Tech stack

- **Frontend:** React 19, TypeScript, Vite (`apps/web`)
- **Backend:** Node.js, Express 5, TypeScript (`apps/api`)
- **MCP server:** official TypeScript MCP SDK (`packages/mcp-server`)
- **Tooling:** npm workspaces, ESLint, Vitest

## Prerequisites

- Node.js **22.12 or newer** — check with `node -v`
- npm **10 or newer** — check with `npm -v`

## Installation

Run all commands from the repository root.

```powershell
npm install
Copy-Item .env.example .env
```

On macOS/Linux use `cp .env.example .env` instead of `Copy-Item`.
The default values in `.env` work as-is. Repository browsing does **not** require any API
key. To enable the Ask panel, set `GEMINI_API_KEY` (backend only).

## Local development

Start the API and the web app together:

```powershell
npm run dev
```

| What           | URL                                |
| -------------- | ---------------------------------- |
| Web app        | http://localhost:5173              |
| API health     | http://localhost:4000/health       |
| API health (via web proxy) | http://localhost:5173/api/health |

The home page shows **API online** when the backend is reachable. Press `Ctrl+C` to stop.

Run one part at a time:

```powershell
npm run dev:api      # Express API with auto-reload (port 4000)
npm run dev:web      # Vite dev server (port 5173)
npm run dev:mcp      # MCP server on stdio (waits for an MCP client)
```

## Tests and checks

```powershell
npm run test         # all workspace tests (Vitest)
npm run test:api     # API tests only
npm run test:mcp     # MCP server tests only
npm run typecheck    # TypeScript in every workspace
npm run lint         # ESLint
npm run build        # production builds -> each package's dist/
npm run check        # typecheck + lint + test + build
npm run verify:hooks # offline check of Cursor hook scripts
```

## Running production builds locally

```powershell
npm run build
npm run start:api    # serves the compiled API on port 4000
npm run preview:web  # serves apps/web/dist on http://localhost:4173
```

## API endpoints

| Method | Path               | Description                                             |
| ------ | ------------------ | ------------------------------------------------------- |
| GET    | `/health`          | Liveness check: `{ status, service, timestamp }`        |
| GET    | `/api/health`      | Same, reachable through the Vite `/api` proxy           |
| POST   | `/api/repos`         | Connect a GitHub repo. Body: `{ "url": "https://github.com/owner/repo", "token?": "<fine-grained PAT>" }`. Public repos work without `token`. Private repos require a token the caller is authorized to use. Returns `{ sessionId, repository, fileCount, createdAt, expiresAt }`. The token is never stored or returned. |
| GET    | `/api/repos/:id`     | Get a connected session's metadata (404 if expired)     |
| DELETE | `/api/repos/:id`     | Disconnect a session and delete its temporary files     |
| GET    | `/api/repos/:id/files`  | List files (via MCP). Optional `?path=<subdir>`      |
| GET    | `/api/repos/:id/search` | Search code (via MCP). `?q=<text>&ext=<optional>`    |
| GET    | `/api/repos/:id/file`   | Read a file (via MCP). `?path=<relative-path>`       |
| POST   | `/api/repos/:id/ask`    | Ask a question about the repo. Body: `{ "question": "…", "history?": [{ "role": "user"\|"assistant", "content": "…" }] }`. Returns `{ answer, sources, grounded, contextFiles }`. `503` if no `GEMINI_API_KEY` |

### Connecting a repository (quick test)

```powershell
curl.exe -X POST http://localhost:4000/api/repos -H "content-type: application/json" -d "{\"url\":\"https://github.com/octocat/Hello-World\"}"
```

Only `https://github.com/<owner>/<repo>` URLs are accepted. Other hosts and local
addresses are rejected. Public repositories work without a token. Private repositories
require a **fine-grained personal access token** that can read that one repo (`Contents:
Read` only). RepoPilot does not bypass GitHub permissions and does not use the server
`GITHUB_TOKEN` to open private repos.

The optional token is used only for that connect request (metadata + archive download).
It is not written to disk, sessions, logs, API responses, MCP, or Gemini. In production
the browser should send it only over HTTPS.

Downloaded files are extracted into a temporary, git-ignored workspace
(`.tmp/repos/<sessionId>`), never executed, and `.git`, `node_modules`, build output and
secret files (like `.env`) are excluded. Sessions expire after 30 minutes and are cleaned
up on failure, on expiry, and on server restart.

### Configuration (optional)

All of these have sensible defaults; set them in `.env` only if you need to change them.

| Variable                   | Default      | Purpose                                             |
| -------------------------- | ------------ | --------------------------------------------------- |
| `GITHUB_TOKEN`             | *(unset)*    | Optional server token to raise **public** GitHub API rate limits. Never sent to the client and **never** used to open a private repository |
| `REPOS_TMP_DIR`            | `.tmp/repos` | Where temporary repository workspaces are created   |
| `SESSION_TTL_MINUTES`      | `30`         | Session lifetime before auto-cleanup                |
| `REPO_MAX_DOWNLOAD_MB`     | `50`         | Max archive download size                           |
| `REPO_MAX_FILE_MB`         | `2`          | Individual files larger than this are skipped (extract, read, search) |
| `REPO_MAX_FILES`           | `5000`       | Max files extracted / listed; also caps search scope |
| `REPO_DOWNLOAD_TIMEOUT_MS` | `30000`      | Download timeout                                    |
| `MCP_MAX_SEARCH_RESULTS`   | `200`        | Max search matches returned                         |
| `MCP_MAX_LINE_LENGTH`      | `300`        | Max characters per matching line                    |
| `GEMINI_API_KEY`           | *(unset)*    | Google Gemini key for the Ask panel. **Optional** — unset disables AI only; backend-only, never sent to the client |
| `GEMINI_MODEL`             | `gemini-3.5-flash-lite` | Gemini model used to answer questions    |
| `GEMINI_TIMEOUT_MS`        | `30000`      | Per-request timeout for Gemini calls                |
| `TRUST_PROXY`              | `false`      | Set to `1` behind a known reverse proxy (e.g. Render) so `req.ip` uses `X-Forwarded-For`. Leave unset locally so clients cannot spoof their IP |
| `RATE_LIMIT_WINDOW_MS`     | `60000`      | Sliding window for per-IP connect/browse limits     |
| `RATE_LIMIT_CONNECT_MAX`   | `10`         | Max `POST /api/repos` requests per IP per window    |
| `RATE_LIMIT_BROWSE_MAX`    | `120`        | Max files/search/file requests per IP per window    |

## Project structure

```
apps/
  web/                 React frontend (Vite)
  api/                 Express backend
packages/
  mcp-server/          MCP server
docs/SYSTEM_DESIGN.md  Architecture
.cursor/rules/         Cursor rules
.cursor/skills/        Cursor Agent Skills
AGENTS.md              Instructions for AI agents
```

## MCP explorer tools

RepoPilot's repository exploration runs through a real MCP server (`packages/mcp-server`)
that exposes three read-only tools over stdio:

| Tool | Input | Returns |
| --- | --- | --- |
| `list_project_files` | `sessionId`, optional `path` | repo-relative file/dir paths |
| `search_project_code` | `sessionId`, `query`, optional `extension` | `{ path, line, text }` matches |
| `read_project_file` | `sessionId`, `path` | file `content` + `lineCount` |

The Express API acts as an MCP **client**: it spawns the MCP server as a child process
and calls these tools. In development the server runs from TypeScript source via `tsx`
(no build needed); in production (`NODE_ENV=production`) it runs the compiled
`packages/mcp-server/dist/index.js`. Every tool call is scoped to one session's workspace
and rejects traversal, symlinks, secret files, and oversized/binary files.

Inspect the MCP server directly (optional):

```powershell
npm run build:mcp
npx @modelcontextprotocol/inspector node packages/mcp-server/dist/index.js
```

## Ask RepoPilot (Gemini AI)

The **Ask RepoPilot** panel in the explorer answers questions about the connected
repository using Google Gemini (`@google/genai`). The flow is:

1. The backend extracts keywords from the question and calls the MCP `search_project_code`
   tool for each (bounded), plus `list_project_files` to find a README.
2. It reads the top-ranked files with the MCP `read_project_file` tool (size- and
   count-limited). **All context comes through the MCP client — the AI service never reads
   the filesystem directly.**
3. That context is sent to Gemini wrapped in `<CONTEXT>` delimiters with a system
   instruction telling the model to treat repository contents as **untrusted data, not
   instructions**, to answer only from the context, and to never invent paths or line
   numbers.
4. The response is `{ answer, sources, grounded, contextFiles }`. Any cited `source` whose
   path was not actually retrieved is dropped, so citations are always grounded.
   `grounded` is `true` only when at least one supporting file is cited.

Safety: the `GEMINI_API_KEY` is read on the backend only and is never exposed to the
browser, logs, or API responses; questions and history are length-bounded; context is
size-capped; a per-session rate limit applies; and requests time out after
`GEMINI_TIMEOUT_MS`. Without a key configured, the endpoint returns `503` and repository
browsing continues to work.

To enable AI locally, set `GEMINI_API_KEY` in `.env` (get a key from Google AI Studio),
optionally override `GEMINI_MODEL`, and restart the API. Live Gemini answering is
**NOT VERIFIED** in this environment.

## Security

- Never commit `.env` or real API keys; only placeholders belong in `.env.example`.
- `GEMINI_API_KEY` is backend-only and is never sent to the frontend, logged, or returned
  in API responses.
- Cloned repositories are treated as untrusted: read-only, never executed, with path
  traversal / symlink / secret-file protections. Their contents are passed to the AI model
  as data, not instructions.
- Optional GitHub PATs for private repos are request-scoped only: never stored in
  localStorage/sessionStorage, sessions, logs, responses, MCP, or Gemini. Prefer a
  fine-grained token limited to one repository with Contents: Read. Do not use broad
  classic tokens.
- **Private code + Ask:** retrieved excerpts may be sent to the configured AI provider.
  Confirm your organization's AI/data-sharing policy first. RepoPilot cannot enforce that
  policy and does not claim company-code privacy guarantees.
- Private-repository support is **MVP** and is not production-ready without a security review.
- Per-IP rate limits on `POST /api/repos` (connect/download) and on files/search/file
  (browse). The Ask endpoint keeps a separate per-session limit in `aiService`. `req.ip`
  is trusted only when `TRUST_PROXY` is set (do not enable that locally).
- Exceeding a limit returns HTTP `429` with `{ "error": "Too many requests. …" }` and a
  `Retry-After` header. No filesystem paths or tokens are included.

## Deployment

| Piece | Host | URL |
| ----- | ---- | --- |
| Frontend | Vercel | https://repopilot-swart.vercel.app |
| API + MCP | Render | https://repopilot-sjux.onrender.com |

Checked: frontend HTTP 200; `GET /health` and `GET /api/health` return ok; CORS allows the Vercel origin; the frontend build includes the Render API base. A full production Ask (live Gemini) pass is **NOT VERIFIED** here. Setup details stay in **[DEPLOY.md](DEPLOY.md)**.

| Piece | Host | Command / env |
| ----- | ---- | ------------- |
| `apps/web` | Vercel (static Vite build) | `npm run build:web` → `apps/web/dist`. `VITE_API_BASE_URL=https://repopilot-sjux.onrender.com` at **build** time |
| `apps/api` + `packages/mcp-server` | Render (Node 22 web service) | `npm run build:backend`, start `npm start`. `WEB_ORIGIN=https://repopilot-swart.vercel.app`, `TRUST_PROXY=1` |

The frontend never holds the Gemini key. CORS is an allow-list of `WEB_ORIGIN` only.

## Troubleshooting

| Symptom | What to check |
| ------- | ------------- |
| Home page shows **API offline** | API not running on port 4000; Vite proxy only forwards `/api/*` |
| Vite started on 5174 | Port 5173 was busy — set `WEB_ORIGIN` to the URL Vite actually printed |
| Connect returns 400 | URL must be `https://github.com/<owner>/<repo>` (public only) |
| Connect/browse returns 429 | Per-IP rate limit — wait for `Retry-After` or raise `RATE_LIMIT_*` in `.env` |
| Ask returns 503 | `GEMINI_API_KEY` unset or still the `.env.example` placeholder |
| Ask returns 502 / 504 | Provider rejected the key, quota, or the request timed out |
| Explorer returns 503 | MCP child failed to start — in production, `npm run build:mcp` must have run |
