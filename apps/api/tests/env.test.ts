import { describe, expect, it } from "vitest";
import { getConfig } from "../src/utils/env.js";

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    PORT: "4000",
    ...overrides,
  };
}

describe("getConfig", () => {
  it("uses safe defaults when optional vars are unset", () => {
    const config = getConfig(baseEnv());
    expect(config.gemini.apiKey).toBeUndefined();
    expect(config.gemini.model).toBe("gemini-3.5-flash-lite");
    expect(config.githubToken).toBeUndefined();
    expect(config.trustProxy).toBe(false);
    expect(config.rateLimit).toEqual({ windowMs: 60_000, connectMax: 10, browseMax: 120 });
  });

  it("ignores .env.example placeholders so they are never treated as real secrets", () => {
    const config = getConfig(
      baseEnv({
        GEMINI_API_KEY: "your_gemini_api_key_here",
        GITHUB_TOKEN: "your_github_token_here",
      }),
    );
    expect(config.gemini.apiKey).toBeUndefined();
    expect(config.githubToken).toBeUndefined();
  });

  it("parses TRUST_PROXY as false / true / hop count", () => {
    expect(getConfig(baseEnv({ TRUST_PROXY: "0" })).trustProxy).toBe(0);
    expect(getConfig(baseEnv({ TRUST_PROXY: "1" })).trustProxy).toBe(1);
    expect(getConfig(baseEnv({ TRUST_PROXY: "true" })).trustProxy).toBe(true);
    expect(getConfig(baseEnv({ TRUST_PROXY: "false" })).trustProxy).toBe(false);
    expect(getConfig(baseEnv({ TRUST_PROXY: "nope" })).trustProxy).toBe(false);
  });

  it("reads configurable rate-limit budgets", () => {
    const config = getConfig(
      baseEnv({
        RATE_LIMIT_WINDOW_MS: "15000",
        RATE_LIMIT_CONNECT_MAX: "3",
        RATE_LIMIT_BROWSE_MAX: "40",
      }),
    );
    expect(config.rateLimit).toEqual({ windowMs: 15_000, connectMax: 3, browseMax: 40 });
  });
});
