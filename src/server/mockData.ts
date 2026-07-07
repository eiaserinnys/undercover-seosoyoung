import type { DiscordMessageRecord } from "../shared/types.js";

const now = "2026-07-07T07:00:00.000Z";

export const mockMessages: DiscordMessageRecord[] = [
  {
    guildId: "guild-eb-official",
    channelId: "channel-feedback",
    channelName: "feedback",
    parentChannelId: null,
    threadId: null,
    messageId: "mock-message-001",
    authorId: "discord-user-001",
    authorName: "Lena",
    authorAvatarUrl: null,
    contentOriginal: "The new boss pattern looks great, but the second phase warning is hard to read.",
    translationKo: null,
    deeplink: "https://discord.com/channels/guild-eb-official/channel-feedback/mock-message-001",
    status: "active",
    detectedLanguage: "en",
    replyState: "unread",
    createdAt: now,
    editedAt: null,
    deletedAt: null,
    receivedAt: now
  },
  {
    guildId: "guild-eb-official",
    channelId: "channel-bugs",
    channelName: "bug-reports",
    parentChannelId: null,
    threadId: "thread-crash-001",
    messageId: "mock-message-002",
    authorId: "discord-user-002",
    authorName: "Rin",
    authorAvatarUrl: null,
    contentOriginal: "Game crashed after opening the inventory during the tutorial fight.",
    translationKo: null,
    deeplink: "https://discord.com/channels/guild-eb-official/thread-crash-001/mock-message-002",
    status: "active",
    detectedLanguage: "en",
    replyState: "unread",
    createdAt: now,
    editedAt: null,
    deletedAt: null,
    receivedAt: now
  },
  {
    guildId: "guild-eb-official",
    channelId: "channel-general",
    channelName: "general",
    parentChannelId: null,
    threadId: null,
    messageId: "mock-message-003",
    authorId: "discord-user-003",
    authorName: "Mika",
    authorAvatarUrl: null,
    contentOriginal: "Is there a Korean guide for the demo?",
    translationKo: null,
    deeplink: "https://discord.com/channels/guild-eb-official/channel-general/mock-message-003",
    status: "edited",
    detectedLanguage: "en",
    replyState: "unread",
    createdAt: now,
    editedAt: "2026-07-07T07:03:00.000Z",
    deletedAt: null,
    receivedAt: now
  }
];
