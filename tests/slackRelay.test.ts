import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase, buildDiscordDeeplink } from "../src/server/database.js";
import {
  AmbiguousSlackError,
  SlackApiError,
  SlackRelayService,
  SlackWebApiClient,
  buildSlackMessagePayload,
  type SlackClient
} from "../src/server/slackRelay.js";
import type { AttachmentDownloader } from "../src/server/discordAttachmentDownloader.js";
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
    db.upsertMessage(message({ messageId: "old", contentOriginal: "old", attachments: [attachment()] }));
    store.initializeBaseline();

    db.saveTranslation("old", "old", "옛 번역", "en", now());
    store.observeMessage("old");
    db.upsertMessage(message({
      messageId: "old",
      contentOriginal: "edited",
      status: "edited",
      attachments: [attachment()]
    }));
    db.saveTranslation("old", "edited", "수정 번역", "en", now());
    store.observeMessage("old");

    expect(store.getState("old")).toMatchObject({ eligible: false, status: "baseline_excluded" });
    expect(store.getAttachmentState("old", attachment().attachmentId)).toBeNull();
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
    const firstJob = store.nextReady();
    expect(firstJob?.pendingAction).toBe("post");
    store.markRetry(
      "new",
      "definite failure",
      new Date(Date.now() + 3_000).toISOString(),
      firstJob!.attemptedRevision!,
      firstJob!.pendingAction
    );
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
  it("uses Slack's three-step external upload contract and groups files under the parent thread", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/files.getUploadURLExternal")) {
        return Response.json({ ok: true, upload_url: "https://files.slack.com/upload/v1/ticket", file_id: "F123" });
      }
      if (url === "https://files.slack.com/upload/v1/ticket") return new Response("OK", { status: 200 });
      if (url.endsWith("/files.completeUploadExternal")) return Response.json({ ok: true, files: [{ id: "F123" }] });
      if (url.endsWith("/files.delete")) return Response.json({ ok: true });
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;
    const client = new SlackWebApiClient("xoxb-test", fetchImpl);

    const ticket = await client.getUploadUrl("capture.png", 4);
    await client.uploadBytes(ticket.uploadUrl, new Uint8Array([1, 2, 3, 4]));
    await client.completeUploadExternal("C0C291S3YFM", "123.456", [{ id: ticket.fileId, title: "capture.png" }]);
    await client.deleteFile(ticket.fileId);

    expect(new Headers(requests[0]?.init?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(String(requests[0]?.init?.body)).toBe("filename=capture.png&length=4");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer xoxb-test");
    expect(new Headers(requests[1]?.init?.headers).get("authorization")).toBeNull();
    expect(new Headers(requests[2]?.init?.headers).get("content-type")).toBe("application/json; charset=utf-8");
    expect(JSON.parse(String(requests[2]?.init?.body))).toEqual({
      channel_id: "C0C291S3YFM",
      thread_ts: "123.456",
      files: [{ id: "F123", title: "capture.png" }]
    });
    expect(requests[3]?.url).toMatch(/\/files\.delete$/);
    expect(JSON.parse(String(requests[3]?.init?.body))).toEqual({ file: "F123" });
  });

  it("builds one rich-text section with a bold linked author and bold channel header", () => {
    const source = message({ contentOriginal: "line one\n```code```", translationKo: "첫 줄\n```코드```", translationStatus: "translated" });

    const payload = buildSlackMessagePayload(source);

    expect(payload).toEqual({
      blocks: [{
        type: "rich_text",
        elements: [{
          type: "rich_text_section",
          elements: [
            { type: "link", url: source.deeplink, text: "🔗 Lena", style: { bold: true } },
            { type: "text", text: " | general", style: { bold: true } },
            { type: "text", text: "\n\n첫 줄\n```코드```" }
          ]
        }]
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

  it("uploads a new message attachment into the parent Slack thread", async () => {
    const { db, store } = fixture();
    store.initializeBaseline();
    db.upsertMessage(message({ messageId: "new", attachments: [attachment()] }));
    db.saveTranslation("new", "hello", "안녕", "en", now());
    const client = fakeSlack();
    const downloader = fakeDownloader();
    const service = new SlackRelayService(store, client, relayConfig(), downloader);
    service.initialize();
    await service.start();

    service.handleMessageChange("new");
    await eventually(() => expect(store.getState("new")?.status).toBe("sent"));

    expect(downloader.calls).toEqual([[attachment(), 20 * 1024 * 1024]]);
    expect(client.calls.filter(([kind]) => kind === "post")).toHaveLength(1);
    expect(client.calls.filter(([kind]) => kind === "completeUpload")).toEqual([[
      "completeUpload",
      "C0C291S3YFM",
      "123.456",
      [{ id: "F1", title: "capture.png" }]
    ]]);
    expect(store.getAttachmentState("new", attachment().attachmentId)).toMatchObject({
      status: "uploaded",
      slackFileId: "F1"
    });

    await service.stop();
    store.close();
    db.close();
  }, 15_000);

  it("relays a media-only message with its header and attachment", async () => {
    const { db, store } = fixture();
    store.initializeBaseline();
    db.upsertMessage(message({ messageId: "media-only", contentOriginal: "", attachments: [attachment()] }));
    const client = fakeSlack();
    const service = new SlackRelayService(store, client, relayConfig(), fakeDownloader());
    service.initialize();
    await service.start();

    service.handleMessageChange("media-only");
    await eventually(() => expect(store.getState("media-only")?.status).toBe("sent"));

    const post = client.calls.find(([kind]) => kind === "post");
    expect(post?.[2]).toEqual(buildSlackMessagePayload(message({
      messageId: "media-only",
      contentOriginal: "",
      attachments: [attachment()],
      translationStatus: "skipped"
    })));
    expect(client.calls.filter(([kind]) => kind === "completeUpload")).toHaveLength(1);

    await service.stop();
    store.close();
    db.close();
  }, 15_000);

  it("keeps the text relay and adds original links when file upload fails", async () => {
    const { db, store } = fixture();
    store.initializeBaseline();
    db.upsertMessage(message({ messageId: "new", attachments: [attachment()] }));
    db.saveTranslation("new", "hello", "안녕", "en", now());
    const client = fakeSlack();
    client.getUploadUrl = async () => { throw new Error("missing_scope"); };
    const service = new SlackRelayService(store, client, relayConfig(), fakeDownloader());
    service.initialize();
    await service.start();

    service.handleMessageChange("new");
    await eventually(() => expect(store.getState("new")?.status).toBe("sent"));

    expect(client.calls.filter(([kind]) => kind === "post")).toHaveLength(1);
    expect(client.calls.filter(([kind]) => kind === "completeUpload")).toHaveLength(0);
    expect(client.calls.filter(([kind]) => kind === "update")).toEqual([[
      "update",
      "C0C291S3YFM",
      "123.456",
      buildSlackMessagePayload(
        { ...db.getMessage("new")!, translationKo: "안녕", translationStatus: "translated" },
        [attachment()]
      )
    ]]);
    expect(store.getAttachmentState("new", attachment().attachmentId)?.status).toBe("failed");

    await service.stop();
    store.close();
    db.close();
  }, 15_000);

  it("does not re-upload an attachment left in-flight across a restart", async () => {
    const { path, db, store } = fixture();
    store.initializeBaseline();
    db.upsertMessage(message({ messageId: "new", attachments: [attachment()] }));
    db.saveTranslation("new", "hello", "안녕", "en", now());
    store.observeMessage("new");
    const postJob = store.nextReady();
    expect(postJob?.pendingAction).toBe("post");
    store.markParentWritten("new", "123.456", postJob!.attemptedRevision!, "post");
    expect(store.nextReady()?.pendingAction).toBe("media");
    expect(store.claimPendingAttachments("new")).toHaveLength(1);
    store.close();

    const restarted = new SlackRelayStore(path);
    const client = fakeSlack();
    const service = new SlackRelayService(restarted, client, relayConfig(), fakeDownloader());
    service.initialize();
    await service.start();
    await eventually(() => expect(restarted.getState("new")?.status).toBe("sent"));

    expect(client.calls.filter(([kind]) => kind === "post")).toHaveLength(0);
    expect(client.calls.filter(([kind]) => kind === "getUpload")).toHaveLength(0);
    expect(client.calls.filter(([kind]) => kind === "completeUpload")).toHaveLength(0);
    expect(client.calls.filter(([kind]) => kind === "update")).toHaveLength(1);
    expect(restarted.getAttachmentState("new", attachment().attachmentId)?.status).toBe("unknown");

    await service.stop();
    restarted.close();
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

  it("deletes uploaded Slack files before deleting the parent for a removed Discord message", async () => {
    const { db, store } = fixture();
    store.initializeBaseline();
    db.upsertMessage(message({ messageId: "new", attachments: [attachment()] }));
    db.saveTranslation("new", "hello", "안녕", "en", now());
    const client = fakeSlack();
    const service = new SlackRelayService(store, client, relayConfig(), fakeDownloader());
    service.initialize();
    await service.start();

    service.handleMessageChange("new");
    await eventually(() => expect(store.getState("new")?.status).toBe("sent"));
    db.markDeleted({ guildId: "guild-1", channelId: "channel-1", threadId: null, messageId: "new", deletedAt: now() });
    service.handleMessageChange("new");
    await eventually(() => expect(store.getState("new")?.slackTs).toBeNull());

    const deleteFileIndex = client.calls.findIndex(([kind]) => kind === "deleteFile");
    const deleteParentIndex = client.calls.findIndex(([kind]) => kind === "delete");
    expect(client.calls[deleteFileIndex]).toEqual(["deleteFile", "F1"]);
    expect(deleteFileIndex).toBeGreaterThan(-1);
    expect(deleteParentIndex).toBeGreaterThan(deleteFileIndex);
    expect(store.getAttachmentState("new", attachment().attachmentId)?.status).toBe("deleted");

    await service.stop();
    store.close();
    db.close();
  }, 15_000);

  it("finishes deletion after restart when Slack reports that the file was already deleted", async () => {
    const { path, db, store } = fixture();
    store.initializeBaseline();
    db.upsertMessage(message({ messageId: "new", attachments: [attachment()] }));
    db.saveTranslation("new", "hello", "안녕", "en", now());
    const initialClient = fakeSlack();
    const initialService = new SlackRelayService(store, initialClient, relayConfig(), fakeDownloader());
    initialService.initialize();
    await initialService.start();
    initialService.handleMessageChange("new");
    await eventually(() => expect(store.getState("new")?.status).toBe("sent"));
    await initialService.stop();

    db.markDeleted({ guildId: "guild-1", channelId: "channel-1", threadId: null, messageId: "new", deletedAt: now() });
    store.observeMessage("new");
    store.close();

    const restarted = new SlackRelayStore(path);
    const retryClient = fakeSlack();
    retryClient.deleteFile = async (fileId) => {
      retryClient.calls.push(["deleteFile", fileId]);
      throw new SlackApiError("Slack files.delete failed: file_deleted", "file_deleted");
    };
    const restartedService = new SlackRelayService(restarted, retryClient, relayConfig(), fakeDownloader());
    restartedService.initialize();
    await restartedService.start();
    await eventually(() => expect(restarted.getState("new")?.slackTs).toBeNull());

    expect(retryClient.calls.filter(([kind]) => kind === "deleteFile")).toEqual([["deleteFile", "F1"]]);
    expect(retryClient.calls.filter(([kind]) => kind === "delete")).toHaveLength(1);
    expect(restarted.getAttachmentState("new", attachment().attachmentId)?.status).toBe("deleted");

    await restartedService.stop();
    restarted.close();
    db.close();
  }, 15_000);

  it("preserves a concurrent Discord delete while an older Slack update completes", async () => {
    const { db, store } = fixture();
    store.initializeBaseline();
    db.upsertMessage(message({ messageId: "new", contentOriginal: "hello" }));
    db.saveTranslation("new", "hello", "안녕", "en", now());
    const client = fakeSlack();
    let service: SlackRelayService;
    service = new SlackRelayService(store, client, relayConfig());
    service.initialize();
    await service.start();
    service.handleMessageChange("new");
    await eventually(() => expect(store.getState("new")?.status).toBe("sent"));

    client.updateMessage = async (channel, ts, payload) => {
      client.calls.push(["update", channel, ts, payload]);
      db.markDeleted({ guildId: "guild-1", channelId: "channel-1", threadId: null, messageId: "new", deletedAt: now() });
      service.handleMessageChange("new");
      return { channel, ts };
    };
    db.upsertMessage(message({ messageId: "new", contentOriginal: "edited", status: "edited" }));
    db.saveTranslation("new", "edited", "수정됨", "en", now());
    service.handleMessageChange("new");

    await eventually(() => expect(client.calls.filter(([kind]) => kind === "delete")).toHaveLength(1));
    expect(store.getState("new")).toMatchObject({ status: "sent", pendingAction: null, slackTs: null });

    await service.stop();
    store.close();
    db.close();
  }, 15_000);

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

  it("marks over-limit rich text as too_long without truncating", async () => {
    const { db, store } = fixture();
    store.initializeBaseline();
    const original = "x";
    db.upsertMessage(message({ messageId: "new", contentOriginal: original }));
    db.saveTranslation("new", original, "한".repeat(10_001), "en", now());
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
    attachments: [],
    translationKo: null, translationStatus: "pending", translationError: null, translatedAt: null,
    deeplink: buildDiscordDeeplink("guild-1", "channel-1", null, messageId), status: "active", detectedLanguage: null,
    replyState: "unread", createdAt: now(), editedAt: null, deletedAt: null, receivedAt: now(), ...overrides
  };
}

function relayConfig() {
  return {
    channelId: "C0C291S3YFM",
    botUserId: "U0A8XJZ6Q5S",
    attachmentMaxBytes: 20 * 1024 * 1024,
    minWriteIntervalMs: 0
  };
}

function fakeSlack(): SlackClient & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    async authTest() { calls.push(["auth.test"]); return { userId: "U0A8XJZ6Q5S" }; },
    async postMessage(channel, payload) { calls.push(["post", channel, payload]); return { channel, ts: "123.456" }; },
    async updateMessage(channel, ts, payload) { calls.push(["update", channel, ts, payload]); return { channel, ts }; },
    async deleteMessage(channel, ts) { calls.push(["delete", channel, ts]); return { channel, ts }; },
    async getUploadUrl(filename, length) {
      const fileId = `F${calls.filter(([kind]) => kind === "getUpload").length + 1}`;
      calls.push(["getUpload", filename, length]);
      return { uploadUrl: `https://files.slack.com/upload/v1/${fileId}`, fileId };
    },
    async uploadBytes(uploadUrl, bytes) { calls.push(["uploadBytes", uploadUrl, [...bytes]]); },
    async completeUploadExternal(channel, threadTs, files) {
      calls.push(["completeUpload", channel, threadTs, files]);
    },
    async deleteFile(fileId) { calls.push(["deleteFile", fileId]); }
  };
}

function fakeDownloader(): AttachmentDownloader & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    async download(source, maxBytes) {
      calls.push([source, maxBytes]);
      return new Uint8Array([1, 2, 3, 4]);
    }
  };
}

function attachment() {
  return {
    attachmentId: "123456789012345678",
    filename: "capture.png",
    contentType: "image/png",
    description: null,
    sizeBytes: 4,
    sourceUrl: "https://cdn.discordapp.com/attachments/111111111111111111/123456789012345678/capture.png?ex=1&is=2&hm=3"
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
