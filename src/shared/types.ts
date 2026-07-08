export type DiscordMessageStatus = "active" | "edited" | "deleted";

export type CollectorMode = "mock" | "live" | "configuration_error";

export type TranslationStatus = "pending" | "translated" | "skipped";

export interface DiscordMessageRecord {
  guildId: string;
  channelId: string;
  channelName: string | null;
  parentChannelId: string | null;
  threadId: string | null;
  messageId: string;
  authorId: string;
  authorName: string;
  authorAvatarUrl: string | null;
  contentOriginal: string;
  translationKo: string | null;
  translationStatus: TranslationStatus;
  translationError: string | null;
  translatedAt: string | null;
  deeplink: string;
  status: DiscordMessageStatus;
  detectedLanguage: string | null;
  replyState: "unread" | "ignored" | "done";
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  receivedAt: string;
}

export interface MessageListResponse {
  messages: DiscordMessageRecord[];
  channels: ChannelSummary[];
  total: number;
  latestEventId: string | null;
}

export interface MessageEventPayload {
  eventId: string;
  message: DiscordMessageRecord;
}

export interface ChannelSummary {
  channelId: string;
  channelName: string | null;
  count: number;
}

export interface DiscordPermissionStatus {
  readOnly: true;
  outboundEnabled: false;
  tokenConfigured: boolean;
  mode: CollectorMode;
  requiredGatewayIntents: string[];
  requiredBotPermissions: string[];
  disallowedBotPermissions: string[];
  configErrors: string[];
}

export interface AuthSettings {
  loginRequired: true;
  slackConfigured: boolean;
  allowedUserIds: string[];
  allowWorkspace: boolean;
  teamIdConfigured: boolean;
}

export interface AuthenticatedUser {
  slackUserId: string;
  slackTeamId: string | null;
  name: string;
  email: string | null;
  avatarUrl: string | null;
}

export type MeResponse =
  | {
      authenticated: true;
      user: AuthenticatedUser;
    }
  | {
      authenticated: false;
      error: "unauthorized";
    };

export interface AppSettings {
  serviceName: "undercover-seosoyoung";
  dashboardTitle: string;
  appBaseUrl: string;
  guildAllowlist: string[];
  channelAllowlist: string[];
  auth: AuthSettings;
  discord: DiscordPermissionStatus;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  service: "undercover-seosoyoung";
  mode: CollectorMode;
  readOnly: true;
  outboundEnabled: false;
  messageCount: number;
  configErrors: string[];
}
