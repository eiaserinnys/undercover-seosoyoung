import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ChannelSummary, DiscordMessageRecord, DiscordMessageStatus, TranslationStatus } from "../shared/types.js";
import { mockMessages } from "./mockData.js";

export interface MessageFilters {
  channelId?: string;
  status?: DiscordMessageStatus;
  limit?: number;
}

export interface MessageChangeResult {
  changed: boolean;
  contentChanged: boolean;
  eventId: string;
  message: DiscordMessageRecord;
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
    this.normalizeTranslationMetadata();
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
        content_hash TEXT NOT NULL DEFAULT '',
        translation_ko TEXT,
        translation_status TEXT NOT NULL DEFAULT 'pending',
        translation_error TEXT,
        translated_at TEXT,
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
      CREATE INDEX IF NOT EXISTS idx_discord_messages_received_at ON discord_messages(received_at);
    `);
    // Backfill new columns BEFORE indexing them. On a pre-existing table
    // (old schema without these columns) `CREATE TABLE IF NOT EXISTS` is a
    // no-op, so an index on a not-yet-added column would throw. Add the
    // columns first, then create their indexes.
    this.addColumnIfMissing("discord_messages", "content_hash", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("discord_messages", "translation_status", "TEXT NOT NULL DEFAULT 'pending'");
    this.addColumnIfMissing("discord_messages", "translation_error", "TEXT");
    this.addColumnIfMissing("discord_messages", "translated_at", "TEXT");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_discord_messages_translation_status ON discord_messages(translation_status);
    `);
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
    if (rows.some((row) => row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private normalizeTranslationMetadata(): void {
    const rows = this.db
      .prepare("SELECT message_id, content_original, content_hash, translation_status FROM discord_messages")
      .all() as Array<Record<string, unknown>>;
    const update = this.db.prepare(
      "UPDATE discord_messages SET content_hash = ?, translation_status = ? WHERE message_id = ?"
    );
    for (const row of rows) {
      const content = text(row.content_original);
      const hash = text(row.content_hash);
      const status = text(row.translation_status);
      if (hash && (status === "pending" || status === "translated" || status === "skipped")) continue;
      update.run(hashContent(content), content ? "pending" : "skipped", text(row.message_id));
    }
  }

  messageCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM discord_messages").get();
    return numberValue(row?.count);
  }

  upsertMessages(messages: DiscordMessageRecord[]): number {
    let changed = 0;
    for (const message of messages) {
      if (this.upsertMessage(message).changed) changed += 1;
    }
    return changed;
  }

  upsertMessage(message: DiscordMessageRecord): MessageChangeResult {
    const existing = this.getMessage(message.messageId);
    const contentChanged = !existing || existing.contentOriginal !== message.contentOriginal;
    const changed =
      !existing ||
      contentChanged ||
      existing.guildId !== message.guildId ||
      existing.channelId !== message.channelId ||
      existing.channelName !== message.channelName ||
      existing.parentChannelId !== message.parentChannelId ||
      existing.threadId !== message.threadId ||
      existing.authorId !== message.authorId ||
      existing.authorName !== message.authorName ||
      existing.authorAvatarUrl !== message.authorAvatarUrl ||
      existing.deeplink !== message.deeplink ||
      existing.status !== message.status ||
      existing.editedAt !== message.editedAt ||
      existing.deletedAt !== message.deletedAt;
    const contentHash = hashContent(message.contentOriginal);
    const translationStatus: TranslationStatus = message.contentOriginal ? "pending" : "skipped";
    this.db
      .prepare(
        `
        INSERT INTO discord_messages (
          message_id, guild_id, channel_id, channel_name, parent_channel_id, thread_id,
          author_id, author_name, author_avatar_url, content_original, content_hash, translation_ko,
          translation_status, translation_error, translated_at, deeplink, status, detected_language,
          reply_state, created_at, edited_at, deleted_at, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          content_hash = excluded.content_hash,
          translation_ko = CASE
            WHEN discord_messages.content_hash = excluded.content_hash THEN discord_messages.translation_ko
            ELSE excluded.translation_ko
          END,
          translation_status = CASE
            WHEN discord_messages.content_hash = excluded.content_hash THEN discord_messages.translation_status
            ELSE excluded.translation_status
          END,
          translation_error = CASE
            WHEN discord_messages.content_hash = excluded.content_hash THEN discord_messages.translation_error
            ELSE NULL
          END,
          translated_at = CASE
            WHEN discord_messages.content_hash = excluded.content_hash THEN discord_messages.translated_at
            ELSE NULL
          END,
          deeplink = excluded.deeplink,
          status = excluded.status,
          detected_language = CASE
            WHEN discord_messages.content_hash = excluded.content_hash THEN discord_messages.detected_language
            ELSE excluded.detected_language
          END,
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
        contentHash,
        message.translationKo,
        translationStatus,
        null,
        null,
        message.deeplink,
        message.status,
        message.detectedLanguage,
        message.replyState,
        message.createdAt,
        message.editedAt,
        message.deletedAt,
        message.receivedAt
      );
    const nextMessage = this.getMessage(message.messageId);
    if (!nextMessage) {
      throw new Error(`Failed to persist Discord message ${message.messageId}`);
    }
    return {
      changed,
      contentChanged,
      eventId: messageEventId(nextMessage),
      message: nextMessage
    };
  }

  markDeleted(input: {
    guildId: string;
    channelId: string;
    threadId: string | null;
    messageId: string;
    deletedAt: string;
  }): MessageChangeResult {
    const existing = this.getMessage(input.messageId);
    if (existing) {
      this.db
        .prepare("UPDATE discord_messages SET status = 'deleted', deleted_at = ?, received_at = ? WHERE message_id = ?")
        .run(input.deletedAt, input.deletedAt, input.messageId);
      const message = this.getMessage(input.messageId);
      if (!message) throw new Error(`Failed to mark Discord message ${input.messageId} as deleted`);
      return {
        changed: existing.status !== "deleted" || existing.deletedAt !== input.deletedAt,
        contentChanged: false,
        eventId: messageEventId(message),
        message
      };
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
      translationStatus: "skipped",
      translationError: null,
      translatedAt: null,
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

  listMessagesAfterEventId(lastEventId: string | null, filters: MessageFilters = {}): DiscordMessageRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const cursor = parseMessageEventId(lastEventId);
    if (cursor) {
      clauses.push("(received_at > ? OR (received_at = ? AND message_id > ?))");
      params.push(cursor.receivedAt, cursor.receivedAt, cursor.messageId);
    }
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
      .prepare(`SELECT * FROM discord_messages ${where} ORDER BY received_at ASC, message_id ASC LIMIT ?`)
      .all(...params, limit)
      .map(mapMessageRow);
  }

  latestEventId(): string | null {
    const row = this.db
      .prepare("SELECT * FROM discord_messages ORDER BY received_at DESC, message_id DESC LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    return row ? messageEventId(mapMessageRow(row)) : null;
  }

  listPendingTranslationMessageIds(limit = 100): string[] {
    return this.db
      .prepare(
        `
        SELECT message_id
        FROM discord_messages
        WHERE translation_status = 'pending'
          AND status != 'deleted'
          AND content_original != ''
        ORDER BY received_at ASC, message_id ASC
        LIMIT ?
      `
      )
      .all(limit)
      .map((row) => text((row as Record<string, unknown>).message_id));
  }

  markTranslationSkipped(messageId: string, detectedLanguage: string, translatedAt: string): MessageChangeResult | null {
    this.db
      .prepare(
        `
        UPDATE discord_messages
        SET translation_status = 'skipped',
            translation_error = NULL,
            translated_at = ?,
            detected_language = ?,
            received_at = ?
        WHERE message_id = ?
      `
      )
      .run(translatedAt, detectedLanguage, translatedAt, messageId);
    return this.changeResultForMessage(messageId, false);
  }

  saveTranslation(messageId: string, translationKo: string, detectedLanguage: string, translatedAt: string): MessageChangeResult | null {
    this.db
      .prepare(
        `
        UPDATE discord_messages
        SET translation_ko = ?,
            translation_status = 'translated',
            translation_error = NULL,
            translated_at = ?,
            detected_language = ?,
            received_at = ?
        WHERE message_id = ?
      `
      )
      .run(translationKo, translatedAt, detectedLanguage, translatedAt, messageId);
    return this.changeResultForMessage(messageId, false);
  }

  markTranslationPending(messageId: string, error: string, receivedAt: string): MessageChangeResult | null {
    this.db
      .prepare(
        `
        UPDATE discord_messages
        SET translation_status = 'pending',
            translation_error = ?,
            received_at = ?
        WHERE message_id = ?
      `
      )
      .run(error, receivedAt, messageId);
    return this.changeResultForMessage(messageId, false);
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

  private changeResultForMessage(messageId: string, contentChanged: boolean): MessageChangeResult | null {
    const message = this.getMessage(messageId);
    if (!message) return null;
    return {
      changed: true,
      contentChanged,
      eventId: messageEventId(message),
      message
    };
  }
}

export function buildDiscordDeeplink(guildId: string, channelId: string, threadId: string | null, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${threadId ?? channelId}/${messageId}`;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function messageEventId(message: Pick<DiscordMessageRecord, "messageId" | "receivedAt">): string {
  return `${message.receivedAt}#${message.messageId}`;
}

function parseMessageEventId(eventId: string | null): { receivedAt: string; messageId: string } | null {
  if (!eventId) return null;
  const separator = eventId.lastIndexOf("#");
  if (separator <= 0 || separator === eventId.length - 1) return null;
  return {
    receivedAt: eventId.slice(0, separator),
    messageId: eventId.slice(separator + 1)
  };
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
    translationStatus: text(row.translation_status) as TranslationStatus,
    translationError: nullableText(row.translation_error),
    translatedAt: nullableText(row.translated_at),
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
