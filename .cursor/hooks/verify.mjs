#!/usr/bin/env node
// Cheap, offline verifier for the project `beforeShellExecution` hook.
// Run from the repo root: `npm run verify:hooks`
// Does not talk to Cursor; it pipes sample JSON into the hook script the same
// way Cursor does (stdin JSON → stdout JSON).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const hook = join(here, "guard-deploy.mjs");

function run(command) {
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ command }),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`hook exited ${result.status}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

const cases = [
  { command: "npm run check", expect: "allow" },
  { command: "vercel deploy", expect: "ask" },
  { command: "git push origin main", expect: "ask" },
  { command: "npm publish", expect: "ask" },
  { command: "render deploy", expect: "ask" },
];

function runEnvGuard(payload) {
  const envHook = join(here, "guard-env-write.mjs");
  const result = spawnSync(process.execPath, [envHook], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`env hook exited ${result.status}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

let failed = 0;
for (const { command, expect } of cases) {
  const out = run(command);
  const ok = out.permission === expect;
  const mark = ok ? "ok" : "FAIL";
  console.log(`${mark}  ${JSON.stringify(command)} → ${out.permission} (want ${expect})`);
  if (!ok) failed += 1;
}

const envCases = [
  { payload: { tool_input: { path: "apps/api/src/app.ts" } }, expect: "allow" },
  { payload: { tool_input: { path: ".env.example" } }, expect: "allow" },
  { payload: { arguments: { path: ".env" } }, expect: "ask" },
  { payload: { path: "apps/web/src/index.css" }, expect: "allow" },
];

for (const { payload, expect } of envCases) {
  const out = runEnvGuard(payload);
  const ok = out.permission === expect;
  const mark = ok ? "ok" : "FAIL";
  console.log(`${mark}  env-write ${JSON.stringify(payload)} → ${out.permission} (want ${expect})`);
  if (!ok) failed += 1;
}

if (failed > 0) {
  process.exit(1);
}
console.log("hooks: all sample inputs matched expected permission");
