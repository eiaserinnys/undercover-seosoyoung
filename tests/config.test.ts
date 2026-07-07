import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("configuration", () => {
  it("ignores a generic inherited PORT and uses the service-specific default", () => {
    process.env.PORT = "4105";
    delete process.env.UNDERCOVER_PORT;

    expect(loadConfig(process.cwd()).port).toBe(4318);
  });

  it("uses UNDERCOVER_PORT when the service explicitly sets it", () => {
    process.env.PORT = "4105";
    process.env.UNDERCOVER_PORT = "4500";

    expect(loadConfig(process.cwd()).port).toBe(4500);
  });

  it("requires an explicit Slack access policy before public deployment", () => {
    process.env.UNDERCOVER_APP_BASE_URL = "https://undercover.eiaserinnys.me";
    process.env.UNDERCOVER_SESSION_SECRET = "test-secret-with-enough-entropy";
    process.env.SLACK_CLIENT_ID = "123.456";
    process.env.SLACK_CLIENT_SECRET = "client-secret";

    expect(loadConfig(process.cwd()).configErrors).toContain(
      "Set UNDERCOVER_ALLOWED_SLACK_USER_IDS or UNDERCOVER_ALLOW_WORKSPACE=true before using a public base URL"
    );
  });

  it("requires a Slack team id for workspace-wide access", () => {
    process.env.UNDERCOVER_APP_BASE_URL = "https://undercover.eiaserinnys.me";
    process.env.UNDERCOVER_SESSION_SECRET = "test-secret-with-enough-entropy";
    process.env.SLACK_CLIENT_ID = "123.456";
    process.env.SLACK_CLIENT_SECRET = "client-secret";
    process.env.UNDERCOVER_ALLOW_WORKSPACE = "true";

    expect(loadConfig(process.cwd()).configErrors).toContain("SLACK_TEAM_ID is required when UNDERCOVER_ALLOW_WORKSPACE=true");
  });

  it("parses Slack user allowlist without requiring workspace-wide access", () => {
    process.env.UNDERCOVER_APP_BASE_URL = "https://undercover.eiaserinnys.me";
    process.env.UNDERCOVER_SESSION_SECRET = "test-secret-with-enough-entropy";
    process.env.SLACK_CLIENT_ID = "123.456";
    process.env.SLACK_CLIENT_SECRET = "client-secret";
    process.env.UNDERCOVER_ALLOWED_SLACK_USER_IDS = "U08HWT0C6K1,U123";

    const config = loadConfig(process.cwd());

    expect(config.slack.allowedUserIds).toEqual(["U08HWT0C6K1", "U123"]);
    expect(config.slack.allowWorkspace).toBe(false);
    expect(config.configErrors).not.toContain(
      "Set UNDERCOVER_ALLOWED_SLACK_USER_IDS or UNDERCOVER_ALLOW_WORKSPACE=true before using a public base URL"
    );
  });

  it("allows Corksheet SSO bridge without a direct Slack client secret", () => {
    process.env.UNDERCOVER_APP_BASE_URL = "https://undercover.eiaserinnys.me";
    process.env.UNDERCOVER_SESSION_SECRET = "test-secret-with-enough-entropy";
    process.env.UNDERCOVER_CORKSHEET_SSO_START_URL = "https://corksheet.eiaserinnys.me/auth/undercover/start";
    process.env.UNDERCOVER_SSO_BRIDGE_SECRET = "bridge-secret-with-enough-entropy";
    process.env.UNDERCOVER_ALLOWED_SLACK_USER_IDS = "U08HWT0C6K1";
    delete process.env.SLACK_CLIENT_ID;
    delete process.env.SLACK_CLIENT_SECRET;

    expect(loadConfig(process.cwd()).configErrors).toEqual([]);
  });
});
