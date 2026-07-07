import { describe, expect, it } from "vitest";
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
    db.upsertMessage(message());
    db.upsertMessage(message({ contentOriginal: "edited", status: "edited", editedAt: "2026-07-07T07:01:00.000Z" }));

    expect(db.messageCount()).toBe(1);
    expect(db.getMessage("message-1")).toMatchObject({
      contentOriginal: "edited",
      status: "edited",
      editedAt: "2026-07-07T07:01:00.000Z"
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
