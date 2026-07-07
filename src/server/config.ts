import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AppSettings, CollectorMode } from "../shared/types.js";

export interface AppConfig {
  port: number;
  appBaseUrl: string;
  databasePath: string;
  dashboardTitle: string;
  discordToken: string | null;
  discordClientId: string | null;
  discordMockMode: boolean;
  guildAllowlist: string[];
  channelAllowlist: string[];
  configErrors: string[];
}

const REQUIRED_GATEWAY_INTENTS = ["Guilds", "GuildMessages", "MessageContent"];
const REQUIRED_BOT_PERMISSIONS = ["View Channels", "Read Message History"];
const DISALLOWED_BOT_PERMISSIONS = ["Send Messages", "Manage Messages", "Use Webhooks"];

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
  const databasePath = readOptionalEnv("UNDERCOVER_DATABASE_PATH") ?? ".data/undercover-seosoyoung.sqlite";
  const resolvedDatabasePath = databasePath === ":memory:" ? databasePath : resolve(rootDir, databasePath);
  if (resolvedDatabasePath !== ":memory:") {
    mkdirSync(dirname(resolvedDatabasePath), { recursive: true });
  }

  const discordToken = readOptionalEnv("DISCORD_BOT_TOKEN");
  const explicitMockMode = readBooleanEnv("DISCORD_MOCK_MODE");
  const discordMockMode = explicitMockMode ?? !discordToken;
  const configErrors = !discordMockMode && !discordToken ? ["DISCORD_BOT_TOKEN is required when DISCORD_MOCK_MODE=false"] : [];

  return {
    port,
    appBaseUrl: readOptionalEnv("UNDERCOVER_APP_BASE_URL") ?? `http://127.0.0.1:${port}`,
    databasePath: resolvedDatabasePath,
    dashboardTitle: readOptionalEnv("UNDERCOVER_DASHBOARD_TITLE") ?? "암행 서소영",
    discordToken,
    discordClientId: readOptionalEnv("DISCORD_CLIENT_ID"),
    discordMockMode,
    guildAllowlist: readCsvEnv("DISCORD_GUILD_ALLOWLIST"),
    channelAllowlist: readCsvEnv("DISCORD_CHANNEL_ALLOWLIST"),
    configErrors
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
