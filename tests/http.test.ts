import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";
import { AppDatabase } from "../src/server/database.js";
import { createAppServer } from "../src/server/http.js";

const servers: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function startServer() {
  const previousDatabasePath = process.env.UNDERCOVER_DATABASE_PATH;
  const previousMockMode = process.env.DISCORD_MOCK_MODE;
  process.env.UNDERCOVER_DATABASE_PATH = ":memory:";
  process.env.DISCORD_MOCK_MODE = "true";
  const config = loadConfig(process.cwd());
  if (previousDatabasePath === undefined) delete process.env.UNDERCOVER_DATABASE_PATH;
  else process.env.UNDERCOVER_DATABASE_PATH = previousDatabasePath;
  if (previousMockMode === undefined) delete process.env.DISCORD_MOCK_MODE;
  else process.env.DISCORD_MOCK_MODE = previousMockMode;

  const db = new AppDatabase(":memory:", true);
  const server = createAppServer({ config, db, staticDir: "dist/client" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("HTTP API", () => {
  it("reports read-only health in mock mode", async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/healthz`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      service: "undercover-seosoyoung",
      mode: "mock",
      readOnly: true,
      outboundEnabled: false
    });
    expect(body.messageCount).toBeGreaterThan(0);
  });

  it("serves messages and settings without write endpoints", async () => {
    const baseUrl = await startServer();
    const messages = await fetch(`${baseUrl}/api/messages`).then((response) => response.json());
    const settings = await fetch(`${baseUrl}/api/settings`).then((response) => response.json());
    const missing = await fetch(`${baseUrl}/api/send`);

    expect(messages.messages.length).toBeGreaterThan(0);
    expect(settings.discord).toMatchObject({
      readOnly: true,
      outboundEnabled: false,
      mode: "mock"
    });
    expect(missing.status).toBe(404);
  });
});
