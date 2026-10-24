#!/usr/bin/env node
// Cursor `preToolUse` hook (schema version 1).
//
// Asks for confirmation before an agent Write/StrReplace targets a real `.env`
// file (never `.env.example` / `.env.sample`). Inspects path-like fields only —
// never file contents — so mentioning ".env" in source does not trip the guard.
// Fails OPEN on parse errors so a broken hook never blocks normal edits.

function collectPaths(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string" && /path$/i.test(key)) out.push(child);
      else collectPaths(child, out);
    }
  }
  return out;
}

function isSecretEnvPath(filePath) {
  const normalized = String(filePath).replaceAll("\\", "/");
  const name = normalized.split("/").pop() ?? "";
  return name === ".env" || (name.startsWith(".env.") && name !== ".env.example" && name !== ".env.sample");
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(raw || "{}");
    const paths = collectPaths(input);
    if (paths.some(isSecretEnvPath)) {
      process.stdout.write(
        JSON.stringify({
          permission: "ask",
          user_message:
            "This edit targets a real .env file, which may contain secrets. " +
            "RepoPilot keeps secrets out of git; review before continuing.",
          agent_message:
            "A project hook flagged a write to .env. Do not commit secrets. " +
            "Prefer .env.example for placeholders.",
        }),
      );
    } else {
      process.stdout.write(JSON.stringify({ permission: "allow" }));
    }
  } catch {
    process.stdout.write(JSON.stringify({ permission: "allow" }));
  }
  process.exit(0);
});
