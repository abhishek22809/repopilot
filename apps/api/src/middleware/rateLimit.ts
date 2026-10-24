import type { RequestHandler } from "express";
import { RepoError } from "../utils/RepoError.js";

export interface RateLimiterOptions {
  /** Sliding window length, in milliseconds. */
  windowMs: number;
  /** Maximum allowed requests per key (IP) within the window. */
  max: number;
  /** Clock override (used by tests). */
  now?: () => number;
}

/**
 * A small, dependency-free per-IP sliding-window rate limiter. Each middleware
 * instance owns its own in-memory store, so separate routers/apps (and each test)
 * get isolated state — no flakiness from shared counters.
 *
 * Keying uses `req.ip`, which Express derives from the socket unless `trust proxy`
 * is configured. We never read `X-Forwarded-For` directly, so forged forwarded
 * headers cannot spoof the key unless the operator explicitly trusts a proxy.
 */
export function createRateLimiter(options: RateLimiterOptions): RequestHandler {
  const { windowMs, max } = options;
  const now = options.now ?? (() => Date.now());
  const hits = new Map<string, number[]>();

  return (req, res, next) => {
    const key = req.ip ?? "unknown";
    const current = now();
    const recent = (hits.get(key) ?? []).filter((t) => current - t < windowMs);

    if (recent.length >= max) {
      res.setHeader("Retry-After", String(Math.ceil(windowMs / 1000)));
      next(new RepoError(429, "Too many requests. Please slow down and try again shortly."));
      return;
    }

    recent.push(current);
    hits.set(key, recent);
    next();
  };
}
