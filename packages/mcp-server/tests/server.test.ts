import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, SERVER_INFO } from "../src/server.js";

describe("RepoPilot MCP server", () => {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const server = createServer();

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("completes the MCP handshake and reports its identity", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    expect(client.getServerVersion()).toMatchObject(SERVER_INFO);
  });
});
