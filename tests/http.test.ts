import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthService, type SlackIdentity, type SlackOAuthClient } from "../src/server/auth.js";
import { loadConfig } from "../src/server/config.js";
import { AppDatabase } from "../src/server/database.js";
import { createAppServer } from "../src/server/http.js";

const servers: Array<{ close: () => void }> = [];
const originalEnv = { ...process.env };

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  process.env = { ...originalEnv };
});

async function startServer(slackClient: SlackOAuthClient = fakeSlackClient()) {
  process.env.UNDERCOVER_DATABASE_PATH = ":memory:";
  process.env.DISCORD_MOCK_MODE = "true";
  process.env.UNDERCOVER_APP_BASE_URL = "https://undercover.eiaserinnys.me";
  process.env.UNDERCOVER_SESSION_SECRET = "test-secret-with-enough-entropy";
  process.env.SLACK_CLIENT_ID = "123.456";
  process.env.SLACK_CLIENT_SECRET = "client-secret";
  process.env.SLACK_REDIRECT_URI = "https://undercover.eiaserinnys.me/auth/slack/callback";
  process.env.SLACK_TEAM_ID = "T123";
  process.env.UNDERCOVER_ALLOW_WORKSPACE = "true";
  const config = loadConfig(process.cwd());

  const db = new AppDatabase(":memory:", true);
  const server = createAppServer({ config, db, staticDir: "dist/client", auth: createAuthService(config, slackClient) });
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

  it("keeps dashboard APIs behind Slack authentication", async () => {
    const baseUrl = await startServer();
    const messages = await fetch(`${baseUrl}/api/messages`);
    const settings = await fetch(`${baseUrl}/api/settings`);
    const me = await fetch(`${baseUrl}/api/me`);
    const missing = await fetch(`${baseUrl}/api/send`);

    expect(messages.status).toBe(401);
    expect(settings.status).toBe(401);
    expect(me.status).toBe(401);
    expect(missing.status).toBe(401);
  });

  it("starts Slack OpenID auth with a sealed state cookie", async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/auth/slack?next=/`, { redirect: "manual" });
    const location = new URL(response.headers.get("location") ?? "");
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(303);
    expect(location.origin + location.pathname).toBe("https://slack.com/openid/connect/authorize");
    expect(location.searchParams.get("client_id")).toBe("123.456");
    expect(location.searchParams.get("redirect_uri")).toBe("https://undercover.eiaserinnys.me/auth/slack/callback");
    expect(location.searchParams.get("scope")).toBe("openid email profile");
    expect(cookie).toContain("undercover_oauth_state=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("sets a secure session after Slack callback and then serves protected APIs", async () => {
    const baseUrl = await startServer();
    const start = await fetch(`${baseUrl}/auth/slack`, { redirect: "manual" });
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const stateCookie = start.headers.get("set-cookie") ?? "";

    const callback = await fetch(`${baseUrl}/auth/slack/callback?state=${state}&code=code-1`, {
      redirect: "manual",
      headers: { cookie: cookieHeader(stateCookie) }
    });
    const sessionCookie = callback.headers.get("set-cookie") ?? "";
    const authedCookie = cookieHeader(sessionCookie);
    const messages = await fetch(`${baseUrl}/api/messages`, { headers: { cookie: authedCookie } }).then((response) => response.json());
    const me = await fetch(`${baseUrl}/api/me`, { headers: { cookie: authedCookie } }).then((response) => response.json());

    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("/");
    expect(sessionCookie).toContain("undercover_session=");
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("Secure");
    expect(messages.messages.length).toBeGreaterThan(0);
    expect(me).toMatchObject({
      authenticated: true,
      user: {
        slackUserId: "U08HWT0C6K1",
        slackTeamId: "T123",
        name: "Director"
      }
    });
  });
});

function fakeSlackClient(overrides: Partial<SlackIdentity> = {}): SlackOAuthClient {
  return {
    async exchangeCode() {
      return { accessToken: "slack-access-token" };
    },
    async fetchUserInfo() {
      return {
        slackUserId: "U08HWT0C6K1",
        slackTeamId: "T123",
        name: "Director",
        email: "director@example.com",
        avatarUrl: null,
        ...overrides
      };
    }
  };
}

function cookieHeader(setCookie: string): string {
  return setCookie.split(";")[0];
}
