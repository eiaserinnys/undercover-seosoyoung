import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase, buildDiscordDeeplink } from "../src/server/database.js";
import {
  AmbiguousSlackError,
  SlackRelayService,
  buildSlackTablePayload,
  type SlackClient
} from "../src/server/slackRelay.js";
import { SlackRelayStore } from "../src/server/slackRelayStore.js";
import type { DiscordMessageRecord } from "../src/shared/types.js";

const created: string[] = [];
const fileTestTmpDir = existsSync("/dev/shm") ? "/dev/shm" : tmpdir();

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { force: true });
});

describe("Slack relay baseline and durable state", () => {
  it("permanently excludes baseline rows even after later translation and edits", () => {
    const { path, db, store } = fixture();
    db.upsertMessage(message({ messageId: "old", contentOriginal: "old" }));
    store.initializeBaseline();

    db.saveTranslation("old", "old", "옛 번역", "en", now());
    store.observeMessage("old");
    db.upsertMessage(message({ messageId: "old", contentOriginal: "edited", status: "edited" }));
    db.saveTranslation("old", "edited", "수정 번역", "en", now());
    store.observeMessage("old");

    expect(store.getState("old")).toMatchObject({ eligible: false, status: "baseline_excluded" });
    expect(store.nextReady()).toBeNull();
    store.close();
    db.close();
    expect(path).toContain("undercover-relay-");
  }, 15_000);

  it("treats only ids first observed after the baseline transaction as eligible", () => {
    const { db, store } = fixture();
    db.upsertMessage(message({ messageId: "old" }));
    store.initializeBaseline();
    db.upsertMessage(message({ messageId: "new", contentOriginal: "new" }));
    db.saveTranslation("new", "new", "새 번역", "en", now());
    store.observeMessage("new");

    expect(store.getState("old")?.eligible).toBe(false);
    expect(store.getState("new")).toMatchObject({ eligible: true, status: "pending", pendingAction: "post" });
    store.close();
    db.close();
  }, 15_000);

  it("reconciles eligible work after restart without enrolling baseline rows", () => {
    const { path, db, store } = fixture();
    db.upsertMessage(message({ messageId: "old" }));
    store.initializeBaseline();
    db.upsertMessage(message({ messageId: "new", contentOriginal: "new" }));
    db.saveTranslation("new", "new", "새 번역", "en", now());
    store.close();

    const restarted = new SlackRelayStore(path);
    restarted.reconcile();
    expect(restarted.getState("old")?.eligible).toBe(false);
    expect(restarted.getState("new")?.pendingAction).toBe("post");
    restarted.close();
    db.close();
  }, 15_000);

  it("rebuilds the timer for a durable definitive-failure retry after restart", async () => {
    const { path, db, store } = fixture();
    store.initializeBaseline();
    db.upsertMessage(message({ messageId: "new", contentOriginal: "hello" }));
    db.saveTranslation("new", "hello", "안녕", "en", now());
    store.observeMessage("new");
    expect(store.nextReady()?.pendingAction).toBe("post");
    store.markRetry("new", "definite failure", new Date(Date.now() + 3_000).toISOString());
    store.close();

    const restarted = new SlackRelayStore(path);
    const client = fakeSlack();
    const service = new SlackRelayService(restarted, client, relayConfig());
    service.initialize();
    await service.start();
    await eventually(() => expect(restarted.getState("new")?.status).toBe("sent"));

    expect(client.calls.filter(([kind]) => kind === "post")).toHaveLength(1);
    await service.stop();
    restarted.close();
    db.close();
  }, 30_000);
});

describe("Slack relay payload and delivery", () => {
  it("builds the exact headerless three-column table without summarizing text", () => {
    const source = message({ contentOriginal: "line one\n```code```", translationKo: "첫 줄\n```코드```", translationStatus: "translated" });

    const payload = buildSlackTablePayload(source);

    expect(payload).toEqual({
      blocks: [{
        type: "table",
        column_settings: [{ is_wrapped: false }, { is_wrapped: true }, { is_wrapped: true }],
        rows: [[
          { type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "link", url: source.deeplink, text: "🔗 Lena" }] }] },
          { type: "raw_text", text: "첫 줄\n```코드```" },
          { type: "raw_text", text: "line one\n```code```" }
        ]]
      }],
      unfurl_links: false,
      unfurl_media: false
    });
  }, 15_000);

  it("checks auth.test user_id and validates post channel and ts", async () => {
    const { db, store } = fixture();
    store.initializeBaseline();
    db.upsertMessage(message({ messageId: "new", contentOriginal: "hello" }));
    db.saveTranslation("new", "hello", "안녕", "en", now());
    const client = fakeSlack();
    const service = new SlackRelayService(store, client, relayConfig());
    service.initialize();

    await service.start();
    service.handleMessageChange("new");
    await eventually(() => expect(store.getState("new")?.status).toBe("sent"));

    expect(client.calls[0]).toEqual(["auth.test"]);
    expect(client.calls[1]?.[0]).toBe("post");
    expect(store.getState("new")?.slackTs).toBe("123.456");
    await service.stop();
    store.close();
    db.close();
  }, 15_000);

  it("deduplicates repeats and mirrors a later source edit and delete", async () => {
    const { db, store } = fixture();
    store.initializeBaseline();
    db.upsertMessage(message({ messageId: "new", contentOriginal: "hello" }));
    db.saveTranslation("new", "hello", "안녕", "en", now());
    const client = fakeSlack();
    const service = new SlackRelayService(store, client, relayConfig());
    service.initialize();
    await service.start();

    service.handleMessageChange("new");
    await eventually(() => expect(store.getState("new")?.status).toBe("sent"));
    service.handleMessageChange("new");
    expect(client.calls.filter(([kind]) => kind === "post")).toHaveLength(1);

    db.upsertMessage(message({ messageId: "new", contentOriginal: "edited", status: "edited" }));
    db.saveTranslation("new", "edited", "수정됨", "en", now());
    service.handleMessageChange("new");
    await eventually(() => expect(client.calls.some(([kind]) => kind === "update")).toBe(true));

    db.markDeleted({ guildId: "guild-1", channelId: "channel-1", threadId: null, messageId: "new", deletedAt: now() });
    service.handleMessageChange("new");
    await eventually(() => expect(client.calls.some(([kind]) => kind === "delete")).toBe(true));

    await service.stop();
    store.close();
    db.close();
  }, 30_000);

  it("keeps an ambiguous post for manual confirmation instead of retrying", async () => {
    const { db, store } = fixture();
    store.initializeBaseline();
    db.upsertMessage(message({ messageId: "new", contentOriginal: "hello" }));
    db.saveTranslation("new", "hello", "안녕", "en", now());
    const client = fakeSlack();
    client.postMessage = async () => { throw new AmbiguousSlackError("timeout"); };
    const service = new SlackRelayService(store, client, relayConfig());
    service.initialize();
    await service.start();
    service.handleMessageChange("new");

    await eventually(() => expect(store.getState("new")?.status).toBe("unknown"));
    expect(store.nextReady()).toBeNull();
    expect(store.getState("new")).toMatchObject({ status: "unknown", slackTs: null, lastError: "timeout" });
    await service.stop();
    store.close();
    db.close();
  }, 15_000);

  it("marks over-limit tables as too_long without truncating", async () => {
    const { db, store } = fixture();
    store.initializeBaseline();
    const original = "x".repeat(6000);
    db.upsertMessage(message({ messageId: "new", contentOriginal: original }));
    db.saveTranslation("new", original, "한".repeat(5000), "en", now());
    const client = fakeSlack();
    const service = new SlackRelayService(store, client, relayConfig());
    service.initialize();
    await service.start();
    service.handleMessageChange("new");

    await eventually(() => expect(store.getState("new")?.status).toBe("too_long"));
    expect(client.calls.filter(([kind]) => kind === "post")).toHaveLength(0);
    expect(db.getMessage("new")?.contentOriginal).toBe(original);
    await service.stop();
    store.close();
    db.close();
  }, 15_000);
});

function fixture(): { path: string; db: AppDatabase; store: SlackRelayStore } {
  const path = join(fileTestTmpDir, `undercover-relay-${randomUUID()}.sqlite`);
  created.push(path);
  const db = new AppDatabase(path);
  const store = new SlackRelayStore(path);
  return { path, db, store };
}

function message(overrides: Partial<DiscordMessageRecord> = {}): DiscordMessageRecord {
  const messageId = overrides.messageId ?? "message-1";
  const contentOriginal = overrides.contentOriginal ?? "hello";
  return {
    guildId: "guild-1", channelId: "channel-1", channelName: "general", parentChannelId: null, threadId: null,
    messageId, authorId: "author-1", authorName: "Lena", authorAvatarUrl: null, contentOriginal,
    translationKo: null, translationStatus: "pending", translationError: null, translatedAt: null,
    deeplink: buildDiscordDeeplink("guild-1", "channel-1", null, messageId), status: "active", detectedLanguage: null,
    replyState: "unread", createdAt: now(), editedAt: null, deletedAt: null, receivedAt: now(), ...overrides
  };
}

function relayConfig() {
  return { channelId: "C0C291S3YFM", botUserId: "U0A8XJZ6Q5S", minWriteIntervalMs: 0 };
}

function fakeSlack(): SlackClient & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    async authTest() { calls.push(["auth.test"]); return { userId: "U0A8XJZ6Q5S" }; },
    async postMessage(channel, payload) { calls.push(["post", channel, payload]); return { channel, ts: "123.456" }; },
    async updateMessage(channel, ts, payload) { calls.push(["update", channel, ts, payload]); return { channel, ts }; },
    async deleteMessage(channel, ts) { calls.push(["delete", channel, ts]); return { channel, ts }; }
  };
}

function now(): string { return "2026-09-17T02:00:00.000Z"; }

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let i = 0; i < 250; i += 1) {
    try { assertion(); return; } catch (error) { last = error; await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  throw last;
}
