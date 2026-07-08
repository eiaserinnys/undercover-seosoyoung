import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/config.js";
import { AppDatabase, buildDiscordDeeplink } from "../src/server/database.js";
import { MessageEventHub } from "../src/server/messageEvents.js";
import { createTranslationService, type TranslationClient } from "../src/server/translation.js";
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
    contentOriginal: "The warning is hard to read.",
    translationKo: null,
    translationStatus: "pending",
    translationError: null,
    translatedAt: null,
    deeplink: buildDiscordDeeplink("guild-1", "channel-1", null, "message-1"),
    status: "active",
    detectedLanguage: null,
    replyState: "unread",
    createdAt: "2026-07-08T07:00:00.000Z",
    editedAt: null,
    deletedAt: null,
    receivedAt: "2026-07-08T07:00:00.000Z"
  };
  return { ...base, ...overrides };
}

describe("translation service", () => {
  it("translates pending non-Korean messages with an injected client", async () => {
    const db = new AppDatabase(":memory:");
    const events = new MessageEventHub();
    const payloads: string[] = [];
    events.subscribe((payload) => payloads.push(payload.message.messageId));
    const client: TranslationClient = {
      async translateToKorean() {
        return { detectedLanguage: "en", translationKo: "경고가 읽기 어렵습니다." };
      }
    };
    const service = createTranslationService(config(), db, events, client);
    const change = db.upsertMessage(message());

    service.handleMessageChange(change);
    await eventually(() => {
      expect(db.getMessage("message-1")).toMatchObject({
        translationKo: "경고가 읽기 어렵습니다.",
        translationStatus: "translated",
        detectedLanguage: "en"
      });
    });
    expect(payloads).toContain("message-1");
    service.stop();
    db.close();
  });

  it("skips Korean messages without calling OpenAI", async () => {
    const db = new AppDatabase(":memory:");
    const events = new MessageEventHub();
    let calls = 0;
    const client: TranslationClient = {
      async translateToKorean() {
        calls += 1;
        return { detectedLanguage: "en", translationKo: "should not happen" };
      }
    };
    const service = createTranslationService(config(), db, events, client);
    const change = db.upsertMessage(message({ contentOriginal: "이미 한국어입니다." }));

    service.handleMessageChange(change);
    await eventually(() => {
      expect(db.getMessage("message-1")).toMatchObject({
        translationKo: null,
        translationStatus: "skipped",
        detectedLanguage: "ko"
      });
    });
    expect(calls).toBe(0);
    service.stop();
    db.close();
  });
});

function config(): AppConfig {
  return {
    port: 4318,
    appBaseUrl: "http://127.0.0.1:4318",
    databasePath: ":memory:",
    dashboardTitle: "암행 서소영",
    discordToken: null,
    discordClientId: null,
    discordMockMode: true,
    guildAllowlist: [],
    channelAllowlist: [],
    authConfigErrors: [],
    slack: {
      clientId: null,
      clientSecret: null,
      redirectUri: "http://127.0.0.1:4318/auth/slack/callback",
      teamId: null,
      allowedUserIds: [],
      allowWorkspace: false,
      sessionSecret: null,
      corksheetSsoStartUrl: null,
      corksheetHandoffSecret: null,
      sessionCookieName: "undercover_session",
      stateCookieName: "undercover_oauth_state"
    },
    openAI: {
      apiKey: "test-key",
      model: "gpt-5-mini"
    },
    configErrors: []
  };
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let index = 0; index < 20; index += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}
