/**
 * An error that is safe to surface to the client. `statusCode` maps to the HTTP
 * response and `message` is a user-facing string that never leaks filesystem
 * paths, tokens, or upstream internals.
 */
export class RepoError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "RepoError";
    this.statusCode = statusCode;
  }
}
