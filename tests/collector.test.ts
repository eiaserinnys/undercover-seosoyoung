import { describe, expect, it } from "vitest";
import { extractDeleteIdentity, isAllowedDiscordMessage, mapDiscordMessage, type DiscordMessageLike } from "../src/server/discordCollector.js";
import type { AppConfig } from "../src/server/config.js";

const config: AppConfig = {
  port: 4318,
  appBaseUrl: "http://127.0.0.1:4318",
  databasePath: ":memory:",
  dashboardTitle: "암행 서소영",
  discordToken: null,
  discordClientId: null,
  discordMockMode: true,
  guildAllowlist: ["guild-1"],
  channelAllowlist: ["channel-1"],
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
  translation: {
    cliPath: null,
    model: "gpt-5.6-luna",
    configErrors: ["CODEX_CLI_PATH is required"]
  },
  slackRelay: {
    enabled: false,
    channelId: null,
    botUserId: null,
    botToken: null,
    attachmentMaxBytes: 20 * 1024 * 1024,
    configErrors: []
  },
  configErrors: []
};

function fakeMessage(overrides: Partial<DiscordMessageLike> = {}): DiscordMessageLike {
  return {
    id: "message-1",
    guildId: "guild-1",
    channelId: "channel-1",
    channel: {
      id: "channel-1",
      name: "general",
      parentId: null,
      isThread: () => false
    },
    author: {
      id: "author-1",
      username: "lena",
      globalName: "Lena",
      displayAvatarURL: () => "https://cdn.example/avatar.png"
    },
    content: "hello discord",
    createdAt: new Date("2026-07-07T07:00:00.000Z"),
    editedAt: null,
    ...overrides
  };
}

describe("Discord collector mapping", () => {
  it("drops messages outside the configured guild and channel allowlists", () => {
    expect(isAllowedDiscordMessage(fakeMessage({ guildId: "other-guild" }), config)).toBe(false);
    expect(isAllowedDiscordMessage(fakeMessage({ channelId: "other-channel" }), config)).toBe(false);
  });

  it("maps Discord messages into read-only persisted records", () => {
    const record = mapDiscordMessage(fakeMessage(), "active", config);

    expect(record).toMatchObject({
      guildId: "guild-1",
      channelId: "channel-1",
      threadId: null,
      messageId: "message-1",
      authorName: "Lena",
      contentOriginal: "hello discord",
      translationStatus: "pending",
      status: "active",
      replyState: "unread"
    });
    expect(record?.deeplink).toBe("https://discord.com/channels/guild-1/channel-1/message-1");
  });

  it("stores thread id separately from the parent channel", () => {
    const record = mapDiscordMessage(
      fakeMessage({
        channelId: "thread-1",
        channel: {
          id: "thread-1",
          name: "crash thread",
          parentId: "channel-1",
          isThread: () => true
        }
      }),
      "active",
      config
    );

    expect(record).toMatchObject({
      channelId: "channel-1",
      parentChannelId: "channel-1",
      threadId: "thread-1",
      deeplink: "https://discord.com/channels/guild-1/thread-1/message-1"
    });
  });

  it("persists Discord attachment metadata for media-only messages", () => {
    const record = mapDiscordMessage(
      fakeMessage({
        content: "",
        attachments: [{
          id: "123456789012345678",
          name: "capture.png",
          contentType: "image/png",
          description: "combat capture",
          size: 4,
          url: "https://cdn.discordapp.com/attachments/111111111111111111/123456789012345678/capture.png?ex=1&is=2&hm=3"
        }]
      }),
      "active",
      config
    );

    expect(record).toMatchObject({
      contentOriginal: "",
      translationStatus: "skipped",
      attachments: [{
        attachmentId: "123456789012345678",
        filename: "capture.png",
        contentType: "image/png",
        sizeBytes: 4
      }]
    });
  });

  it("does not normalize an unhydrated partial update into empty content and attachments", () => {
    const record = mapDiscordMessage(
      fakeMessage({ partial: true, content: null, attachments: undefined }),
      "edited",
      config
    );

    expect(record).toBeNull();
  });

  it("extracts delete identities without needing original content", () => {
    expect(extractDeleteIdentity(fakeMessage(), config)).toEqual({
      guildId: "guild-1",
      channelId: "channel-1",
      threadId: null,
      messageId: "message-1"
    });
  });
});
