// Cursor `beforeShellExecution` hook (schema version 1).
//
// Enforces RepoPilot's safety rule: do not deploy, and do not modify any Vercel or
// Render project, without explicit approval. When a shell command looks like a deploy
// or a push, we ask the user to confirm instead of silently running it.
//
// Cross-platform: invoked as `node .cursor/hooks/guard-deploy.mjs` so it needs no bash
// or jq. Reads the hook JSON from stdin and writes a decision JSON to stdout.
// Fails OPEN (allows) on any parsing/runtime error so a broken hook never blocks work.

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  let command = "";
  try {
    command = String(JSON.parse(raw || "{}").command ?? "");
  } catch {
    // Unparsable input: fail open.
    process.stdout.write(JSON.stringify({ permission: "allow" }));
    process.exit(0);
  }

  // Deploy/push-ish commands. `render` is narrowed to its CLI verbs so the common
  // word "render" (e.g. a build step) does not trip the guard.
  const flagged =
    /\b(vercel|netlify)\b/i.test(command) ||
    /\brender\s+(deploy|services|up)\b/i.test(command) ||
    /\bgit\s+push\b/i.test(command) ||
    /\bnpm\s+publish\b/i.test(command);

  if (flagged) {
    process.stdout.write(
      JSON.stringify({
        permission: "ask",
        user_message:
          "This command may deploy or push. RepoPilot's safety rules say not to deploy " +
          "or modify Vercel/Render without explicit approval. Review before continuing.",
        agent_message:
          "A project hook flagged this as a possible deploy/push. Confirm it is intended " +
          "and explicitly approved before proceeding.",
      }),
    );
  } else {
    process.stdout.write(JSON.stringify({ permission: "allow" }));
  }
  process.exit(0);
});
