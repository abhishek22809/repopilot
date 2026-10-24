# Deployment checklist

Published origins (do not reuse a different Vercel or Render project unless you
intend to replace these):

| Piece | URL |
| ----- | --- |
| Frontend (Vercel) | https://repopilot-swart.vercel.app |
| API (Render) | https://repopilot-sjux.onrender.com |
| GitHub | https://github.com/abhishek22809/repopilot |

Health (`/health`, `/api/health`) and CORS for the Vercel origin were checked.
Live Gemini Ask on production is **NOT VERIFIED** until you exercise it.

The tables below are the settings used to create those services.

Verified from this repository:

| Step | Command / setting | Source |
| ---- | ----------------- | ------ |
| Install | `npm install` from the repo root | root `package.json` workspaces |
| Backend build | `npm run build:backend` | builds `@repopilot/mcp-server` then `@repopilot/api` |
| Backend start | `npm start` or `npm run start:api` | `node dist/index.js` in `apps/api` |
| Frontend build | `npm run build:web` | Vite output `apps/web/dist` |
| Health | `GET /health` and `GET /api/health` | `apps/api/src/routes/health.ts` |
| Node | `>=22.12.0` | root `engines` |

The API **cannot** run as a Vercel serverless function. It needs a long-lived
Node process, a writable disk for extracted repos, and a **stdio child process**
for `packages/mcp-server`. That matches a Render **web service**, not a static
host. The frontend is a static Vite app and matches Vercel.

In production (`NODE_ENV=production`) the API spawns
`packages/mcp-server/dist/index.js`. If that file is missing, startup throws.
`tsx` is a **devDependency** and will not be available in a production install.

## 1. Create a new GitHub repository (do this later, not during local prep)

There is currently **no local `.git` directory** and **no remote**. When you
choose to publish:

```powershell
cd "<path-to-repopilot>"
git init
git add .
git status
```

Confirm `.env`, `.tmp/`, `node_modules/`, `dist/`, and tokens are **not**
staged. Then:

```powershell
git commit -m "Initial RepoPilot commit."
gh repo create repopilot --private --source=. --remote=origin
git push -u origin HEAD
```

Use `--public` instead of `--private` if you want a public repo. Do not put
real keys in the commit. After the remote exists, GitHub Actions
(`.github/workflows/check.yml`) will run `npm ci`, `npm run check`, and
`npm run verify:hooks` on push/PR to `main` or `master`.

## 2. Deploy the API on a **new** Render web service

Create a new Web Service from the GitHub repo (root directory = repository root).

| Render field | Value | Why |
| ------------ | ----- | --- |
| Runtime | Node | Express + `node dist/index.js` |
| Node version | `22` | `engines.node` is `>=22.12.0` |
| Build command | `npm install && npm run build:backend` | MCP `dist` must exist before start |
| Start command | `npm start` | alias of `npm run start:api` |
| Health check path | `/health` | existing liveness route |

Do **not** hard-code a port. The process reads `PORT` (`apps/api/src/utils/env.ts`).
Render injects `PORT`; the local default `4000` is only used when `PORT` is unset.

Set `NODE_ENV=production` (Render usually does this). Required so the API
spawns the compiled MCP server, not `tsx`.

### Render environment variables (names only)

**Required for a working browser UI**

| Name | Set to |
| ---- | ------ |
| `NODE_ENV` | `production` |
| `WEB_ORIGIN` | Exact frontend origin, e.g. `https://<your-vercel-app>.vercel.app` (no trailing slash) |
| `TRUST_PROXY` | `1` (Render is a reverse proxy; needed for per-IP rate limits) |

**Recommended**

| Name | Purpose |
| ---- | ------- |
| `REPOS_TMP_DIR` | Writable dir for extracted repos. Default `.tmp/repos` (relative to repo root) is fine on Render’s ephemeral disk. Sessions already expire (`SESSION_TTL_MINUTES`, default 30). |
| `GEMINI_API_KEY` | Optional. Unset = browsing works, Ask returns 503. Never put this on Vercel. |
| `GEMINI_MODEL` | Optional. Default `gemini-3.5-flash-lite`. |
| `GEMINI_TIMEOUT_MS` | Optional. Default `30000`. |
| `GITHUB_TOKEN` | Optional. Public GitHub rate-limit helper only. **Never** used to open private repos. |

**Optional (defaults exist)**

`PORT` (set by Render), `SESSION_TTL_MINUTES`, `REPO_MAX_DOWNLOAD_MB`,
`REPO_MAX_FILE_MB`, `REPO_MAX_FILES`, `REPO_DOWNLOAD_TIMEOUT_MS`,
`MCP_MAX_SEARCH_RESULTS`, `MCP_MAX_LINE_LENGTH`, `RATE_LIMIT_WINDOW_MS`,
`RATE_LIMIT_CONNECT_MAX`, `RATE_LIMIT_BROWSE_MAX`.

After Render gives you a public URL, note it for the frontend build
(e.g. `https://<service>.onrender.com`). No trailing slash.

## 3. Deploy the frontend on a **new** Vercel project

Create a new Vercel project from the same GitHub repo. Root directory = repository
root (this repo’s `vercel.json` already sets the Vite build output).

| Vercel field | Value | Why |
| ------------ | ----- | --- |
| Framework | Vite (or Other) | `apps/web` is Vite |
| Install | default `npm install` | workspaces live at the repo root |
| Build | `npm run build:web` | from `vercel.json` |
| Output | `apps/web/dist` | from `vercel.json` |

### Vercel environment variables (names only)

| Name | Set to |
| ---- | ------ |
| `VITE_API_BASE_URL` | Public API origin, e.g. `https://<service>.onrender.com` (no trailing slash) |

This value is **baked in at build time**. After you set it, trigger a **rebuild**.
Leave it empty only for local Vite (dev proxy). On Vercel, an empty value makes
the browser call `/api` on the Vercel origin, which has no API.

Do **not** set `GEMINI_API_KEY` or `GITHUB_TOKEN` on Vercel.

Then set Render `WEB_ORIGIN` to the Vercel origin (`https://<project>.vercel.app`,
no trailing slash) and restart the API so CORS allows the frontend.

## 4. Local production-build smoke test (optional, before you publish)

```powershell
npm run check
npm run build:backend
$env:NODE_ENV="production"
npm start
```

In another terminal:

```powershell
curl.exe http://localhost:4000/health
```

Expect `{ "status": "ok", "service": "repopilot-api", ... }`. Stop the API when done.
This does **not** prove Render or Vercel work.

## 5. Blockers and security notes

- No git repo exists yet; nothing can be pushed until you run `git init` and create a remote.
- CORS is an allow-list of one origin (`WEB_ORIGIN`). Vercel preview URLs will fail until
  `WEB_ORIGIN` matches that exact origin.
- Sessions and rate-limit maps are **in-memory**. A Render restart or sleep (free tier)
  drops every connected repository. Clients must reconnect.
- Disk is ephemeral unless you attach a Render disk. Short session TTL makes ephemeral
  disk acceptable; do not assume files survive deploys.
- Private-repo PATs are request-scoped and must only be sent over **HTTPS** in production.
- Private-repo + Ask can send retrieved excerpts to Gemini. That is an organizational
  policy decision, not something RepoPilot can enforce.
- Private-repo support is documented as MVP and has not had a dedicated production
  security review.
- Live Gemini Ask on production remains **NOT VERIFIED** until you actually exercise it.
