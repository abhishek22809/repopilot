/**
 * A tool error whose `status` and `message` are safe to relay to the HTTP client.
 * Tool handlers convert these into a structured, non-throwing tool result.
 */
export class ToolError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ToolError";
    this.status = status;
  }
}
