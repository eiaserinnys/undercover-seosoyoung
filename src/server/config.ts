import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AppSettings, CollectorMode } from "../shared/types.js";

export interface AppConfig {
  port: number;
  appBaseUrl: string;
  databasePath: string;
  dashboardTitle: string;
  slack: SlackAuthConfig;
  discordToken: string | null;
  discordClientId: string | null;
  discordMockMode: boolean;
  guildAllowlist: string[];
  channelAllowlist: string[];
  authConfigErrors: string[];
  configErrors: string[];
  translation: TranslationConfig;
  slackRelay: SlackRelayConfig;
}

export interface SlackAuthConfig {
  clientId: string | null;
  clientSecret: string | null;
  redirectUri: string;
  teamId: string | null;
  allowedUserIds: string[];
  allowWorkspace: boolean;
  sessionSecret: string | null;
  corksheetSsoStartUrl: string | null;
  corksheetHandoffSecret: string | null;
  sessionCookieName: string;
  stateCookieName: string;
}

export interface TranslationConfig {
  cliPath: string | null;
  model: string;
  configErrors: string[];
}

export interface SlackRelayConfig {
  enabled: boolean;
  channelId: string | null;
  botUserId: string | null;
  botToken: string | null;
  attachmentMaxBytes: number;
  configErrors: string[];
}

const REQUIRED_GATEWAY_INTENTS = ["Guilds", "GuildMessages", "MessageContent"];
const REQUIRED_BOT_PERMISSIONS = ["View Channels", "Read Message History"];
const DISALLOWED_BOT_PERMISSIONS = ["Send Messages", "Manage Messages", "Use Webhooks"];
const DEFAULT_TRANSLATION_MODEL = "gpt-5.6-luna";
const DEFAULT_SLACK_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

function loadDotEnvFile(path: string): void {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^"|"$/g, "");
  }
}

function readOptionalEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function readBooleanEnv(name: string): boolean | null {
  const raw = readOptionalEnv(name);
  if (raw === null) return null;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} must be a boolean`);
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = readOptionalEnv(name);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function readCsvEnv(name: string): string[] {
  const raw = readOptionalEnv(name);
  if (raw === null) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function loadConfig(rootDir = process.cwd()): AppConfig {
  loadDotEnvFile(resolve(rootDir, ".env"));
  loadDotEnvFile(resolve(rootDir, ".env.local"));

  const port = readPositiveIntEnv("UNDERCOVER_PORT", 4318);
  const appBaseUrl = readOptionalEnv("UNDERCOVER_APP_BASE_URL") ?? `http://127.0.0.1:${port}`;
  const databasePath = readOptionalEnv("UNDERCOVER_DATABASE_PATH") ?? ".data/undercover-seosoyoung.sqlite";
  const resolvedDatabasePath = databasePath === ":memory:" ? databasePath : resolve(rootDir, databasePath);
  if (resolvedDatabasePath !== ":memory:") {
    mkdirSync(dirname(resolvedDatabasePath), { recursive: true });
  }

  const discordToken = readOptionalEnv("DISCORD_BOT_TOKEN");
  const explicitMockMode = readBooleanEnv("DISCORD_MOCK_MODE");
  const discordMockMode = explicitMockMode ?? !discordToken;
  const discordConfigErrors = !discordMockMode && !discordToken ? ["DISCORD_BOT_TOKEN is required when DISCORD_MOCK_MODE=false"] : [];
  const translation = loadTranslationConfig();
  const slackRelay = loadSlackRelayConfig();
  const slack = loadSlackAuthConfig(appBaseUrl);
  const authConfigErrors = validateSlackAuthConfig(appBaseUrl, slack);
  // Translation and relay are independent workers. A missing worker credential
  // must not disable the read-only Discord collector or dashboard.
  const configErrors = [...discordConfigErrors, ...authConfigErrors];

  return {
    port,
    appBaseUrl,
    databasePath: resolvedDatabasePath,
    dashboardTitle: readOptionalEnv("UNDERCOVER_DASHBOARD_TITLE") ?? "암행 서소영",
    slack,
    discordToken,
    discordClientId: readOptionalEnv("DISCORD_CLIENT_ID"),
    discordMockMode,
    guildAllowlist: readCsvEnv("DISCORD_GUILD_ALLOWLIST"),
    channelAllowlist: readCsvEnv("DISCORD_CHANNEL_ALLOWLIST"),
    authConfigErrors,
    configErrors,
    translation,
    slackRelay
  };
}

export function collectorMode(config: AppConfig): CollectorMode {
  if (config.configErrors.length > 0) return "configuration_error";
  return config.discordMockMode ? "mock" : "live";
}

export function configToSettings(config: AppConfig): AppSettings {
  return {
    serviceName: "undercover-seosoyoung",
    dashboardTitle: config.dashboardTitle,
    appBaseUrl: config.appBaseUrl,
    guildAllowlist: config.guildAllowlist,
    channelAllowlist: config.channelAllowlist,
    auth: {
      loginRequired: true,
      slackConfigured: config.authConfigErrors.length === 0,
      allowedUserIds: [...config.slack.allowedUserIds],
      allowWorkspace: config.slack.allowWorkspace,
      teamIdConfigured: Boolean(config.slack.teamId)
    },
    discord: {
      readOnly: true,
      outboundEnabled: false,
      tokenConfigured: Boolean(config.discordToken),
      mode: collectorMode(config),
      requiredGatewayIntents: [...REQUIRED_GATEWAY_INTENTS],
      requiredBotPermissions: [...REQUIRED_BOT_PERMISSIONS],
      disallowedBotPermissions: [...DISALLOWED_BOT_PERMISSIONS],
      configErrors: [...config.configErrors]
    }
  };
}

function loadSlackAuthConfig(appBaseUrl: string): SlackAuthConfig {
  return {
    clientId: readOptionalEnv("SLACK_CLIENT_ID"),
    clientSecret: readOptionalEnv("SLACK_CLIENT_SECRET"),
    redirectUri: readOptionalEnv("SLACK_REDIRECT_URI") ?? new URL("/auth/slack/callback", appBaseUrl).toString(),
    teamId: readOptionalEnv("SLACK_TEAM_ID"),
    allowedUserIds: readCsvEnv("UNDERCOVER_ALLOWED_SLACK_USER_IDS"),
    allowWorkspace: readBooleanEnv("UNDERCOVER_ALLOW_WORKSPACE") ?? false,
    sessionSecret: readOptionalEnv("UNDERCOVER_SESSION_SECRET"),
    corksheetSsoStartUrl: readOptionalEnv("UNDERCOVER_CORKSHEET_SSO_START_URL"),
    corksheetHandoffSecret: readOptionalEnv("UNDERCOVER_SSO_BRIDGE_SECRET"),
    sessionCookieName: "undercover_session",
    stateCookieName: "undercover_oauth_state"
  };
}

function loadTranslationConfig(): TranslationConfig {
  const cliPath = readOptionalEnv("CODEX_CLI_PATH");
  return {
    cliPath,
    model: DEFAULT_TRANSLATION_MODEL,
    configErrors: cliPath ? [] : ["CODEX_CLI_PATH is required"]
  };
}

function loadSlackRelayConfig(): SlackRelayConfig {
  const enabled = readBooleanEnv("UNDERCOVER_SLACK_RELAY_ENABLED") ?? false;
  const channelId = readOptionalEnv("UNDERCOVER_SLACK_RELAY_CHANNEL_ID");
  const botUserId = readOptionalEnv("UNDERCOVER_SLACK_RELAY_BOT_USER_ID");
  const botToken = readOptionalEnv("SLACK_BOT_TOKEN");
  const attachmentMaxBytes = readPositiveIntEnv(
    "UNDERCOVER_SLACK_RELAY_ATTACHMENT_MAX_BYTES",
    DEFAULT_SLACK_ATTACHMENT_MAX_BYTES
  );
  const configErrors: string[] = [];
  if (enabled) {
    if (!channelId) configErrors.push("UNDERCOVER_SLACK_RELAY_CHANNEL_ID is required when relay is enabled");
    if (!botUserId) configErrors.push("UNDERCOVER_SLACK_RELAY_BOT_USER_ID is required when relay is enabled");
    if (!botToken) configErrors.push("SLACK_BOT_TOKEN is required when relay is enabled");
  }
  return { enabled, channelId, botUserId, botToken, attachmentMaxBytes, configErrors };
}

function validateSlackAuthConfig(appBaseUrl: string, slack: SlackAuthConfig): string[] {
  const errors: string[] = [];
  const usesCorksheetSso = Boolean(slack.corksheetSsoStartUrl);
  if (usesCorksheetSso) {
    if (!slack.corksheetHandoffSecret || slack.corksheetHandoffSecret.length < 24) {
      errors.push("UNDERCOVER_SSO_BRIDGE_SECRET must be at least 24 characters");
    }
  } else {
    if (!slack.clientId) errors.push("SLACK_CLIENT_ID is required");
    if (!slack.clientSecret) errors.push("SLACK_CLIENT_SECRET is required");
  }
  if (!slack.sessionSecret || slack.sessionSecret.length < 24) {
    errors.push("UNDERCOVER_SESSION_SECRET must be at least 24 characters");
  }
  if (slack.allowWorkspace && !slack.teamId) {
    errors.push("SLACK_TEAM_ID is required when UNDERCOVER_ALLOW_WORKSPACE=true");
  }
  if (isPublicBaseUrl(appBaseUrl) && slack.allowedUserIds.length === 0 && !slack.allowWorkspace) {
    errors.push("Set UNDERCOVER_ALLOWED_SLACK_USER_IDS or UNDERCOVER_ALLOW_WORKSPACE=true before using a public base URL");
  }
  return errors;
}

function isPublicBaseUrl(value: string): boolean {
  const url = new URL(value);
  return !["localhost", "127.0.0.1", "::1"].includes(url.hostname);
}
