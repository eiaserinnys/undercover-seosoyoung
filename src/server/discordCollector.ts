import { Client, Events, GatewayIntentBits, Partials, type Message, type PartialMessage } from "discord.js";
import type { AppConfig } from "./config.js";
import { buildDiscordDeeplink, type AppDatabase } from "./database.js";
import type { DiscordMessageRecord } from "../shared/types.js";

export interface MessageCollector {
  mode: "mock" | "live" | "configuration_error";
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface DiscordMessageLike {
  id: string;
  guildId: string | null;
  channelId: string;
  channel?: {
    id: string;
    name?: string | null;
    parentId?: string | null;
    isThread?: () => boolean;
  } | null;
  author?: {
    id: string;
    username?: string;
    globalName?: string | null;
    bot?: boolean;
    displayAvatarURL?: () => string;
  } | null;
  content?: string | null;
  createdAt?: Date;
  editedAt?: Date | null;
  partial?: boolean;
}

export class NoopCollector implements MessageCollector {
  readonly mode: MessageCollector["mode"];

  constructor(mode: MessageCollector["mode"]) {
    this.mode = mode;
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}
}

export class DiscordGatewayCollector implements MessageCollector {
  readonly mode = "live";
  private readonly client: Client;

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase
  ) {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
      partials: [Partials.Message, Partials.Channel]
    });
    this.registerHandlers();
  }

  async start(): Promise<void> {
    if (!this.config.discordToken) return;
    await this.client.login(this.config.discordToken);
  }

  async stop(): Promise<void> {
    this.client.removeAllListeners();
    await this.client.destroy();
  }

  private registerHandlers(): void {
    this.client.on(Events.MessageCreate, (message) => {
      this.persistMessage(message, "active");
    });
    this.client.on(Events.MessageUpdate, (_oldMessage, newMessage) => {
      this.persistMessage(newMessage, "edited");
    });
    this.client.on(Events.MessageDelete, (message) => {
      this.persistDelete(message);
    });
  }

  private persistMessage(message: Message | PartialMessage, status: "active" | "edited"): void {
    const normalized = mapDiscordMessage(message as DiscordMessageLike, status, this.config);
    if (normalized) this.db.upsertMessage(normalized);
  }

  private persistDelete(message: Message | PartialMessage): void {
    const basic = extractDeleteIdentity(message as DiscordMessageLike, this.config);
    if (!basic) return;
    this.db.markDeleted({ ...basic, deletedAt: new Date().toISOString() });
  }
}

export function createCollector(config: AppConfig, db: AppDatabase): MessageCollector {
  if (config.configErrors.length > 0) return new NoopCollector("configuration_error");
  if (config.discordMockMode) return new NoopCollector("mock");
  return new DiscordGatewayCollector(config, db);
}

export function isAllowedDiscordMessage(message: DiscordMessageLike, config: Pick<AppConfig, "guildAllowlist" | "channelAllowlist">): boolean {
  if (!message.guildId) return false;
  if (config.guildAllowlist.length > 0 && !config.guildAllowlist.includes(message.guildId)) return false;
  const candidateChannelIds = [message.channelId, message.channel?.parentId ?? null].filter((value): value is string => Boolean(value));
  if (config.channelAllowlist.length > 0 && !candidateChannelIds.some((id) => config.channelAllowlist.includes(id))) {
    return false;
  }
  return true;
}

export function mapDiscordMessage(
  message: DiscordMessageLike,
  status: "active" | "edited",
  config: Pick<AppConfig, "guildAllowlist" | "channelAllowlist">
): DiscordMessageRecord | null {
  if (!isAllowedDiscordMessage(message, config)) return null;
  if (!message.guildId) return null;
  const channelIsThread = Boolean(message.channel?.isThread?.());
  const threadId = channelIsThread ? message.channelId : null;
  const parentChannelId = channelIsThread ? (message.channel?.parentId ?? null) : null;
  const now = new Date().toISOString();
  const createdAt = message.createdAt?.toISOString() ?? now;
  const editedAt = status === "edited" ? (message.editedAt?.toISOString() ?? now) : (message.editedAt?.toISOString() ?? null);
  return {
    guildId: message.guildId,
    channelId: parentChannelId ?? message.channelId,
    channelName: message.channel?.name ?? null,
    parentChannelId,
    threadId,
    messageId: message.id,
    authorId: message.author?.id ?? "unknown",
    authorName: message.author?.globalName ?? message.author?.username ?? "Unknown",
    authorAvatarUrl: message.author?.displayAvatarURL?.() ?? null,
    contentOriginal: message.content ?? "",
    translationKo: null,
    deeplink: buildDiscordDeeplink(message.guildId, parentChannelId ?? message.channelId, threadId, message.id),
    status,
    detectedLanguage: null,
    replyState: "unread",
    createdAt,
    editedAt,
    deletedAt: null,
    receivedAt: now
  };
}

export function extractDeleteIdentity(
  message: DiscordMessageLike,
  config: Pick<AppConfig, "guildAllowlist" | "channelAllowlist">
): { guildId: string; channelId: string; threadId: string | null; messageId: string } | null {
  if (!isAllowedDiscordMessage(message, config)) return null;
  if (!message.guildId) return null;
  const channelIsThread = Boolean(message.channel?.isThread?.());
  const threadId = channelIsThread ? message.channelId : null;
  const channelId = channelIsThread ? (message.channel?.parentId ?? message.channelId) : message.channelId;
  return {
    guildId: message.guildId,
    channelId,
    threadId,
    messageId: message.id
  };
}
