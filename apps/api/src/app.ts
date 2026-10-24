import cors from "cors";
import express from "express";
import helmet from "helmet";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { healthRouter } from "./routes/health.js";
import { createReposRouter } from "./routes/repos.js";
import type { AiService } from "./services/aiService.js";
import type { RepoService } from "./services/githubService.js";
import type { McpClient } from "./services/mcpClient.js";
import type { RateLimitConfig } from "./utils/env.js";

export interface AppDeps {
  webOrigin: string;
  /** Optional so lightweight tests (e.g. health checks) can omit it. */
  repoService?: RepoService;
  /** Optional MCP client used by the repository-explorer endpoints. */
  mcpClient?: McpClient;
  /** Optional AI service used by the ask endpoint. */
  aiService?: AiService;
  /** Per-IP rate-limit config for connect/browse endpoints (sensible defaults apply). */
  rateLimit?: RateLimitConfig;
  /** Express `trust proxy` setting; default `false` (ignore forwarded headers). */
  trustProxy?: number | boolean;
}

export function createApp(deps: AppDeps) {
  const app = express();

  app.disable("x-powered-by");
  // Only honor X-Forwarded-For when a trusted proxy is explicitly configured, so
  // clients cannot spoof their IP to bypass the rate limiter.
  app.set("trust proxy", deps.trustProxy ?? false);
  app.use(helmet());
  app.use(cors({ origin: deps.webOrigin }));
  app.use(express.json({ limit: "100kb" }));

  app.use("/health", healthRouter);
  // The web app reaches the API through the Vite proxy, which only forwards /api/*.
  app.use("/api/health", healthRouter);

  if (deps.repoService) {
    const reposRouter = createReposRouter(
      deps.repoService,
      deps.mcpClient,
      deps.aiService,
      deps.rateLimit,
    );
    app.use("/repos", reposRouter);
    app.use("/api/repos", reposRouter);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
