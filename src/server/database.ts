import { DatabaseSync } from "node:sqlite";
import type { ChannelSummary, DiscordMessageRecord, DiscordMessageStatus } from "../shared/types.js";
import { mockMessages } from "./mockData.js";

export interface MessageFilters {
  channelId?: string;
  status?: DiscordMessageStatus;
  limit?: number;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

export class AppDatabase {
  private readonly db: DatabaseSync;

  constructor(path: string, seedMockData = false) {
    this.db = new DatabaseSync(path);
    this.initialize();
    if (seedMockData && this.messageCount() === 0) {
      this.upsertMessages(mockMessages);
    }
  }

  close(): void {
    this.db.close();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS discord_messages (
        message_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        channel_name TEXT,
        parent_channel_id TEXT,
        thread_id TEXT,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_avatar_url TEXT,
        content_original TEXT NOT NULL,
        translation_ko TEXT,
        deeplink TEXT NOT NULL,
        status TEXT NOT NULL,
        detected_language TEXT,
        reply_state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        edited_at TEXT,
        deleted_at TEXT,
        received_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_discord_messages_channel ON discord_messages(channel_id);
      CREATE INDEX IF NOT EXISTS idx_discord_messages_status ON discord_messages(status);
      CREATE INDEX IF NOT EXISTS idx_discord_messages_created_at ON discord_messages(created_at);
    `);
  }

  messageCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM discord_messages").get();
    return numberValue(row?.count);
  }

  upsertMessages(messages: DiscordMessageRecord[]): number {
    let changed = 0;
    for (const message of messages) {
      changed += this.upsertMessage(message);
    }
    return changed;
  }

  upsertMessage(message: DiscordMessageRecord): number {
    const result = this.db
      .prepare(
        `
        INSERT INTO discord_messages (
          message_id, guild_id, channel_id, channel_name, parent_channel_id, thread_id,
          author_id, author_name, author_avatar_url, content_original, translation_ko,
          deeplink, status, detected_language, reply_state, created_at, edited_at, deleted_at, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(message_id) DO UPDATE SET
          guild_id = excluded.guild_id,
          channel_id = excluded.channel_id,
          channel_name = excluded.channel_name,
          parent_channel_id = excluded.parent_channel_id,
          thread_id = excluded.thread_id,
          author_id = excluded.author_id,
          author_name = excluded.author_name,
          author_avatar_url = excluded.author_avatar_url,
          content_original = excluded.content_original,
          translation_ko = excluded.translation_ko,
          deeplink = excluded.deeplink,
          status = excluded.status,
          detected_language = excluded.detected_language,
          edited_at = excluded.edited_at,
          deleted_at = excluded.deleted_at,
          received_at = excluded.received_at
      `
      )
      .run(
        message.messageId,
        message.guildId,
        message.channelId,
        message.channelName,
        message.parentChannelId,
        message.threadId,
        message.authorId,
        message.authorName,
        message.authorAvatarUrl,
        message.contentOriginal,
        message.translationKo,
        message.deeplink,
        message.status,
        message.detectedLanguage,
        message.replyState,
        message.createdAt,
        message.editedAt,
        message.deletedAt,
        message.receivedAt
      );
    return Number(result.changes);
  }

  markDeleted(input: {
    guildId: string;
    channelId: string;
    threadId: string | null;
    messageId: string;
    deletedAt: string;
  }): number {
    const existing = this.getMessage(input.messageId);
    if (existing) {
      const result = this.db
        .prepare("UPDATE discord_messages SET status = 'deleted', deleted_at = ?, received_at = ? WHERE message_id = ?")
        .run(input.deletedAt, input.deletedAt, input.messageId);
      return Number(result.changes);
    }

    return this.upsertMessage({
      guildId: input.guildId,
      channelId: input.channelId,
      channelName: null,
      parentChannelId: null,
      threadId: input.threadId,
      messageId: input.messageId,
      authorId: "unknown",
      authorName: "Unknown",
      authorAvatarUrl: null,
      contentOriginal: "",
      translationKo: null,
      deeplink: buildDiscordDeeplink(input.guildId, input.channelId, input.threadId, input.messageId),
      status: "deleted",
      detectedLanguage: null,
      replyState: "unread",
      createdAt: input.deletedAt,
      editedAt: null,
      deletedAt: input.deletedAt,
      receivedAt: input.deletedAt
    });
  }

  getMessage(messageId: string): DiscordMessageRecord | null {
    const row = this.db.prepare("SELECT * FROM discord_messages WHERE message_id = ?").get(messageId);
    return row ? mapMessageRow(row) : null;
  }

  listMessages(filters: MessageFilters = {}): DiscordMessageRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filters.channelId) {
      clauses.push("channel_id = ?");
      params.push(filters.channelId);
    }
    if (filters.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filters.limit && filters.limit > 0 ? Math.min(filters.limit, 200) : 100;
    return this.db
      .prepare(`SELECT * FROM discord_messages ${where} ORDER BY created_at DESC, message_id DESC LIMIT ?`)
      .all(...params, limit)
      .map(mapMessageRow);
  }

  listChannels(): ChannelSummary[] {
    return this.db
      .prepare(
        `
        SELECT channel_id, channel_name, COUNT(*) AS count
        FROM discord_messages
        GROUP BY channel_id, channel_name
        ORDER BY count DESC, channel_id ASC
      `
      )
      .all()
      .map((row) => ({
        channelId: text(row.channel_id),
        channelName: nullableText(row.channel_name),
        count: numberValue(row.count)
      }));
  }
}

export function buildDiscordDeeplink(guildId: string, channelId: string, threadId: string | null, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${threadId ?? channelId}/${messageId}`;
}

function mapMessageRow(row: Record<string, unknown>): DiscordMessageRecord {
  return {
    guildId: text(row.guild_id),
    channelId: text(row.channel_id),
    channelName: nullableText(row.channel_name),
    parentChannelId: nullableText(row.parent_channel_id),
    threadId: nullableText(row.thread_id),
    messageId: text(row.message_id),
    authorId: text(row.author_id),
    authorName: text(row.author_name),
    authorAvatarUrl: nullableText(row.author_avatar_url),
    contentOriginal: text(row.content_original),
    translationKo: nullableText(row.translation_ko),
    deeplink: text(row.deeplink),
    status: text(row.status) as DiscordMessageStatus,
    detectedLanguage: nullableText(row.detected_language),
    replyState: text(row.reply_state) as DiscordMessageRecord["replyState"],
    createdAt: text(row.created_at),
    editedAt: nullableText(row.edited_at),
    deletedAt: nullableText(row.deleted_at),
    receivedAt: text(row.received_at)
  };
}
