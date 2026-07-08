import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase, buildDiscordDeeplink } from "../src/server/database.js";
import type { DiscordMessageRecord } from "../src/shared/types.js";

function message(overrides: Partial<DiscordMessageRecord> = {}): DiscordMessageRecord {
  const base: DiscordMessageRecord = {
    guildId: "guild-1",
    channelId: "channel-1",
    channelName: "general",
    parentChannelId: null,
    threadId: null,
    messageId: "message-1",
    authorId: "author-1",
    authorName: "Lena",
    authorAvatarUrl: null,
    contentOriginal: "hello",
    translationKo: null,
    translationStatus: "pending",
    translationError: null,
    translatedAt: null,
    deeplink: buildDiscordDeeplink("guild-1", "channel-1", null, "message-1"),
    status: "active",
    detectedLanguage: "en",
    replyState: "unread",
    createdAt: "2026-07-07T07:00:00.000Z",
    editedAt: null,
    deletedAt: null,
    receivedAt: "2026-07-07T07:00:00.000Z"
  };
  return { ...base, ...overrides };
}

describe("AppDatabase", () => {
  it("idempotently upserts Discord messages by message_id", () => {
    const db = new AppDatabase(":memory:");
    const first = db.upsertMessage(message());
    const duplicate = db.upsertMessage(message());
    const edited = db.upsertMessage(message({ contentOriginal: "edited", status: "edited", editedAt: "2026-07-07T07:01:00.000Z" }));

    expect(db.messageCount()).toBe(1);
    expect(first.changed).toBe(true);
    expect(duplicate.changed).toBe(false);
    expect(edited.contentChanged).toBe(true);
    expect(db.getMessage("message-1")).toMatchObject({
      contentOriginal: "edited",
      translationStatus: "pending",
      status: "edited",
      editedAt: "2026-07-07T07:01:00.000Z"
    });
    db.close();
  });

  it("preserves translation for metadata updates and clears it when source content changes", () => {
    const db = new AppDatabase(":memory:");
    db.upsertMessage(message());
    db.saveTranslation("message-1", "안녕하세요", "en", "2026-07-07T07:01:00.000Z");

    db.upsertMessage(
      message({
        status: "edited",
        editedAt: "2026-07-07T07:02:00.000Z",
        receivedAt: "2026-07-07T07:02:00.000Z"
      })
    );
    expect(db.getMessage("message-1")).toMatchObject({
      translationKo: "안녕하세요",
      translationStatus: "translated"
    });

    db.upsertMessage(
      message({
        contentOriginal: "hello again",
        status: "edited",
        editedAt: "2026-07-07T07:03:00.000Z",
        receivedAt: "2026-07-07T07:03:00.000Z"
      })
    );
    expect(db.getMessage("message-1")).toMatchObject({
      translationKo: null,
      translationStatus: "pending",
      translatedAt: null
    });
    db.close();
  });

  it("marks existing messages as deleted without removing the source row", () => {
    const db = new AppDatabase(":memory:");
    db.upsertMessage(message());
    db.markDeleted({
      guildId: "guild-1",
      channelId: "channel-1",
      threadId: null,
      messageId: "message-1",
      deletedAt: "2026-07-07T07:02:00.000Z"
    });

    expect(db.getMessage("message-1")).toMatchObject({
      status: "deleted",
      deletedAt: "2026-07-07T07:02:00.000Z",
      contentOriginal: "hello"
    });
    db.close();
  });

  it("uses thread id in Discord deep links when a message belongs to a thread", () => {
    expect(buildDiscordDeeplink("guild-1", "channel-1", "thread-1", "message-1")).toBe(
      "https://discord.com/channels/guild-1/thread-1/message-1"
    );
  });
});

describe("AppDatabase migrations", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const path of created.splice(0)) {
      rmSync(path, { force: true });
    }
  });

  it("migrates a pre-translation table (old schema, no new columns) without throwing", () => {
    const path = join(tmpdir(), `undercover-legacy-${randomUUID()}.sqlite`);
    created.push(path);

    // Recreate the pre-translation on-disk schema: no content_hash,
    // translation_status, translation_error, or translated_at columns.
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE discord_messages (
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
    `);
    legacy
      .prepare(
        `INSERT INTO discord_messages (
          message_id, guild_id, channel_id, channel_name, parent_channel_id, thread_id,
          author_id, author_name, author_avatar_url, content_original, translation_ko,
          deeplink, status, detected_language, reply_state, created_at, edited_at, deleted_at, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "legacy-1", "guild-1", "channel-1", "general", null, null,
        "author-1", "Lena", null, "hello world", null,
        buildDiscordDeeplink("guild-1", "channel-1", null, "legacy-1"),
        "active", null, "unread", "2026-07-07T07:00:00.000Z", null, null, "2026-07-07T07:00:00.000Z"
      );
    legacy.close();

    // Opening the app database must add the missing columns and index in order.
    const db = new AppDatabase(path);
    expect(db.messageCount()).toBe(1);
    expect(db.getMessage("legacy-1")).toMatchObject({
      contentOriginal: "hello world",
      translationStatus: "pending"
    });
    db.close();
  });
});
