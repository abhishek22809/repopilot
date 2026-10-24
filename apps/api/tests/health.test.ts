import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

const app = createApp({ webOrigin: "http://localhost:5173" });

describe.each(["/health", "/api/health"])("GET %s", (path) => {
  it("returns ok status as JSON", async () => {
    const response = await request(app).get(path);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    expect(response.body).toMatchObject({ status: "ok", service: "repopilot-api" });
    expect(Number.isNaN(Date.parse(response.body.timestamp))).toBe(false);
  });
});

describe("unknown routes", () => {
  it("returns 404 JSON", async () => {
    const response = await request(app).get("/api/does-not-exist");

    expect(response.status).toBe(404);
    expect(response.body.error).toContain("/api/does-not-exist");
  });
});
