import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Dashboard } from "../src/client/components/Dashboard.js";
import { LoginScreen } from "../src/client/components/LoginScreen.js";
import type { AppSettings, MessageListResponse } from "../src/shared/types.js";

const settings: AppSettings = {
  serviceName: "undercover-seosoyoung",
  dashboardTitle: "암행 서소영",
  appBaseUrl: "http://127.0.0.1:4318",
  guildAllowlist: ["guild-1"],
  channelAllowlist: ["channel-1"],
  auth: {
    loginRequired: true,
    slackConfigured: true,
    allowedUserIds: ["U08HWT0C6K1"],
    allowWorkspace: false,
    teamIdConfigured: true
  },
  discord: {
    readOnly: true,
    outboundEnabled: false,
    tokenConfigured: false,
    mode: "mock",
    requiredGatewayIntents: ["Guilds", "GuildMessages", "MessageContent"],
    requiredBotPermissions: ["View Channels", "Read Message History"],
    disallowedBotPermissions: ["Send Messages", "Manage Messages", "Use Webhooks"],
    configErrors: []
  }
};

const messageData: MessageListResponse = {
  total: 1,
  latestEventId: "2026-07-07T07:00:00.000Z#message-1",
  channels: [{ channelId: "channel-1", channelName: "general", count: 1 }],
  messages: [
    {
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
      translationKo: "경고가 읽기 어렵습니다.",
      translationStatus: "translated",
      translationError: null,
      translatedAt: "2026-07-07T07:01:00.000Z",
      deeplink: "https://discord.com/channels/guild-1/channel-1/message-1",
      status: "active",
      detectedLanguage: "en",
      replyState: "unread",
      createdAt: "2026-07-07T07:00:00.000Z",
      editedAt: null,
      deletedAt: null,
      receivedAt: "2026-07-07T07:00:00.000Z"
    }
  ]
};

describe("Dashboard smoke", () => {
  it("renders the read-only inbox without reply controls", () => {
    const html = renderToString(
      <Dashboard
        settings={settings}
        messageData={messageData}
        selectedChannelId=""
        error={null}
        streamState="connected"
        onSelectChannel={() => {}}
      />
    );

    expect(html).toContain("읽기 전용");
    expect(html).toContain("Discord에 쓰지 않음");
    expect(html).toContain("The warning is hard to read.");
    expect(html).toContain("경고가 읽기 어렵습니다.");
    expect(html).toContain("실시간 연결");
    expect(html).toContain("Discord에서 열기");
    expect(html).not.toContain("답장");
    expect(html).not.toContain("전송");
  });
});

describe("Login screen", () => {
  it("offers Slack login without rendering inbox content", () => {
    const html = renderToString(<LoginScreen error={null} />);

    expect(html).toContain("Slack으로 로그인");
    expect(html).not.toContain("원문 인박스");
    expect(html).not.toContain("Discord에서 열기");
  });
});
