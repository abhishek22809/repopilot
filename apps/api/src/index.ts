import { createApp } from "./app.js";
import { createAiService } from "./services/aiService.js";
import { createRepoService } from "./services/githubService.js";
import { assertProductionMcpBuild, createMcpClient } from "./services/mcpClient.js";
import { getConfig, loadRootEnvFile } from "./utils/env.js";

loadRootEnvFile();
const config = getConfig();
assertProductionMcpBuild(config.nodeEnv);

const repoService = createRepoService(config);
// Remove any repository clones left behind by a previous (crashed) process.
const removed = await repoService.sweepOrphans();
if (removed > 0) {
  console.log(`Cleaned up ${removed} abandoned repository workspace(s).`);
}

const mcpClient = createMcpClient({ reposDir: config.reposDir, nodeEnv: config.nodeEnv });
const aiService = createAiService(config.gemini, { mcp: mcpClient });

const app = createApp({
  webOrigin: config.webOrigin,
  repoService,
  mcpClient,
  aiService,
  rateLimit: config.rateLimit,
  trustProxy: config.trustProxy,
});

const server = app.listen(config.port, () => {
  const ai = aiService.isConfigured() ? "AI enabled" : "AI disabled (no GEMINI_API_KEY)";
  console.log(`RepoPilot API listening on http://localhost:${config.port} (${config.nodeEnv}; ${ai})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    repoService.shutdown();
    void mcpClient.close();
    server.close(() => process.exit(0));
  });
}
