import { Router, type RequestHandler } from "express";
import { createRateLimiter } from "../middleware/rateLimit.js";
import type { AiService, HistoryTurn } from "../services/aiService.js";
import type { RepoService } from "../services/githubService.js";
import type { McpClient } from "../services/mcpClient.js";
import type { RepoSession } from "../services/sessionStore.js";
import type { RateLimitConfig } from "../utils/env.js";
import { normalizeGitHubToken } from "../utils/githubToken.js";
import { RepoError } from "../utils/RepoError.js";

/** Defaults applied when the caller does not provide rate-limit config. */
const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  windowMs: 60_000,
  connectMax: 10,
  browseMax: 120,
};

/** Shape returned to the client. Never includes server filesystem paths. */
function toResponse(session: RepoSession) {
  return {
    sessionId: session.id,
    repository: session.repository,
    fileCount: session.fileCount,
    createdAt: new Date(session.createdAt).toISOString(),
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
}

export function createReposRouter(
  service: RepoService,
  mcp?: McpClient,
  ai?: AiService,
  rateLimit: RateLimitConfig = DEFAULT_RATE_LIMIT,
): Router {
  const router = Router();

  // Per-IP limiters. Connecting a repo triggers an outbound GitHub download, so it
  // gets a tighter budget than the cheaper browse endpoints.
  const connectLimiter = createRateLimiter({ windowMs: rateLimit.windowMs, max: rateLimit.connectMax });
  const browseLimiter = createRateLimiter({ windowMs: rateLimit.windowMs, max: rateLimit.browseMax });

  /** Validate a session id against the active in-memory store. */
  function activeSessionId(id: unknown): string {
    if (typeof id !== "string") {
      throw new RepoError(400, "Invalid session id.");
    }
    if (!service.get(id)) {
      throw new RepoError(404, "Session not found or expired.");
    }
    return id;
  }

  function requireMcp(): McpClient {
    if (!mcp) {
      throw new RepoError(503, "Repository explorer is not configured.");
    }
    return mcp;
  }

  function requireAi(): AiService {
    if (!ai) {
      throw new RepoError(503, "AI is not configured. Set GEMINI_API_KEY to enable Ask RepoPilot.");
    }
    return ai;
  }

  /** Validate and bound optional conversation history from the request body. */
  function parseHistory(raw: unknown): HistoryTurn[] | undefined {
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw)) {
      throw new RepoError(400, "'history' must be an array of { role, content }.");
    }
    const turns: HistoryTurn[] = [];
    for (const item of raw) {
      const role = (item as { role?: unknown } | null)?.role;
      const content = (item as { content?: unknown } | null)?.content;
      if ((role === "user" || role === "assistant") && typeof content === "string") {
        turns.push({ role, content });
      }
    }
    return turns;
  }

  const connect: RequestHandler = async (req, res, next) => {
    try {
      const body = req.body as { url?: unknown; token?: unknown } | undefined;
      const url = body?.url;
      if (typeof url !== "string") {
        throw new RepoError(400, "Request body must include a 'url' string.");
      }
      const token = normalizeGitHubToken(body?.token);
      const session = await service.connect(url, token);
      res.status(201).json(toResponse(session));
    } catch (error) {
      next(error);
    }
  };

  const read: RequestHandler = (req, res, next) => {
    try {
      const id = req.params.id;
      if (typeof id !== "string") {
        throw new RepoError(400, "Invalid session id.");
      }
      const session = service.get(id);
      if (!session) {
        throw new RepoError(404, "Session not found or expired.");
      }
      res.json(toResponse(session));
    } catch (error) {
      next(error);
    }
  };

  const remove: RequestHandler = async (req, res, next) => {
    try {
      const id = req.params.id;
      if (typeof id !== "string") {
        throw new RepoError(400, "Invalid session id.");
      }
      await service.disconnect(id);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  };

  const listFiles: RequestHandler = async (req, res, next) => {
    try {
      const id = activeSessionId(req.params.id);
      const path = typeof req.query.path === "string" ? req.query.path : undefined;
      const data = await requireMcp().callTool("list_project_files", {
        sessionId: id,
        ...(path !== undefined ? { path } : {}),
      });
      res.json(data);
    } catch (error) {
      next(error);
    }
  };

  const searchCode: RequestHandler = async (req, res, next) => {
    try {
      const id = activeSessionId(req.params.id);
      const query = req.query.q;
      if (typeof query !== "string" || query.trim() === "") {
        throw new RepoError(400, "A non-empty 'q' query parameter is required.");
      }
      const extension = typeof req.query.ext === "string" ? req.query.ext : undefined;
      const data = await requireMcp().callTool("search_project_code", {
        sessionId: id,
        query,
        ...(extension !== undefined ? { extension } : {}),
      });
      res.json(data);
    } catch (error) {
      next(error);
    }
  };

  const readFile: RequestHandler = async (req, res, next) => {
    try {
      const id = activeSessionId(req.params.id);
      const path = req.query.path;
      if (typeof path !== "string" || path.trim() === "") {
        throw new RepoError(400, "A 'path' query parameter is required.");
      }
      const data = await requireMcp().callTool("read_project_file", { sessionId: id, path });
      res.json(data);
    } catch (error) {
      next(error);
    }
  };

  const ask: RequestHandler = async (req, res, next) => {
    try {
      const id = activeSessionId(req.params.id);
      const body = req.body as { question?: unknown; history?: unknown } | undefined;
      const question = body?.question;
      if (typeof question !== "string" || question.trim() === "") {
        throw new RepoError(400, "A non-empty 'question' is required.");
      }
      const history = parseHistory(body?.history);
      const result = await requireAi().ask(id, question, history);
      res.json(result);
    } catch (error) {
      next(error);
    }
  };

  router.post("/", connectLimiter, connect);
  // Explorer routes are registered before "/:id" so the extra path segment matches.
  router.get("/:id/files", browseLimiter, listFiles);
  router.get("/:id/search", browseLimiter, searchCode);
  router.get("/:id/file", browseLimiter, readFile);
  // The ask endpoint keeps its own per-session rate limit in the AI service.
  router.post("/:id/ask", ask);
  router.get("/:id", read);
  router.delete("/:id", remove);

  return router;
}
