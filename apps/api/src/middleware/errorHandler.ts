import type { ErrorRequestHandler, RequestHandler } from "express";
import { RepoError } from "../utils/RepoError.js";

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  // RepoError messages are intentionally safe to show to the client.
  if (err instanceof RepoError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  console.error(err);
  // Never leak internal error details to clients.
  res.status(500).json({ error: "Internal server error" });
};
