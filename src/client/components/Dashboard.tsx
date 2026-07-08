import { Avatar } from "@astryxdesign/core/Avatar";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { HStack, Layout, VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import type { AppSettings, AuthenticatedUser, DiscordMessageRecord, MessageListResponse } from "../../shared/types.js";

export interface DashboardProps {
  settings: AppSettings | null;
  messageData: MessageListResponse;
  selectedChannelId: string;
  error: string | null;
  streamState: "idle" | "connected" | "reconnecting";
  user?: AuthenticatedUser | null;
  onLogout?: () => void;
  onSelectChannel(channelId: string): void;
}

export function Dashboard({
  settings,
  messageData,
  selectedChannelId,
  error,
  streamState,
  user,
  onLogout,
  onSelectChannel
}: DashboardProps) {
  const modeLabel = settings?.discord.mode === "live" ? "Live Gateway" : settings?.discord.mode === "configuration_error" ? "설정 확인 필요" : "Mock mode";
  return (
    <main className="dashboard-shell">
      <Layout
        start={
          <aside className="sidebar" aria-label="대시보드 제어">
            <VStack gap={5}>
              <VStack gap={1}>
                <Text type="supporting" weight="bold">
                  Discord Ops
                </Text>
                <Heading level={1}>{settings?.dashboardTitle ?? "암행 서소영"}</Heading>
              </VStack>
              {user ? <UserPanel user={user} onLogout={onLogout} /> : null}
              <ReadOnlyPanel modeLabel={modeLabel} streamState={streamState} />
              <ChannelFilters messageData={messageData} selectedChannelId={selectedChannelId} onSelectChannel={onSelectChannel} />
            </VStack>
            <SettingsPanel settings={settings} />
          </aside>
        }
        content={
          <section className="inbox" aria-label="Discord 메시지 인박스">
            <VStack gap={4}>
              <HStack justify="between" align="center" gap={4} wrap="wrap">
                <VStack gap={1}>
                  <Text type="supporting" weight="bold">
                    Read-only collector
                  </Text>
                  <Heading level={2}>원문 + 한국어 번역 인박스</Heading>
                </VStack>
                <HStack gap={2} align="center" wrap="wrap">
                  <Badge label={`${messageData.messages.length}개 표시`} variant="neutral" />
                  <StreamBadge state={streamState} />
                </HStack>
              </HStack>
              {error ? <StatusNotice tone="warning" message={error} /> : null}
              {settings?.discord.configErrors.length ? <StatusNotice tone="warning" message={settings.discord.configErrors.join(", ")} /> : null}
              <VStack gap={3}>
                {messageData.messages.map((message) => (
                  <MessageCard key={message.messageId} message={message} />
                ))}
                {messageData.messages.length === 0 ? <EmptyInbox /> : null}
              </VStack>
            </VStack>
          </section>
        }
      />
    </main>
  );
}

function UserPanel({ user, onLogout }: { user: AuthenticatedUser; onLogout?: () => void }) {
  return (
    <Card padding={3}>
      <HStack gap={3} align="center">
        <Avatar src={user.avatarUrl ?? undefined} name={user.name} size={36} />
        <VStack gap={0.5} className="minmax-panel">
          <Text type="label" maxLines={1}>
            {user.name}
          </Text>
          <Text type="supporting" maxLines={1}>
            {user.email ?? user.slackUserId}
          </Text>
        </VStack>
        {onLogout ? <Button label="로그아웃" size="sm" variant="ghost" onClick={onLogout} /> : null}
      </HStack>
    </Card>
  );
}

function ReadOnlyPanel({ modeLabel, streamState }: { modeLabel: string; streamState: DashboardProps["streamState"] }) {
  return (
    <Card padding={3} variant="green">
      <VStack gap={2}>
        <HStack gap={2} align="center" wrap="wrap">
          <Badge label="읽기 전용" variant="success" />
          <StreamBadge state={streamState} />
        </HStack>
        <Text type="supporting">Discord에 쓰지 않음 · {modeLabel}</Text>
      </VStack>
    </Card>
  );
}

function ChannelFilters({
  messageData,
  selectedChannelId,
  onSelectChannel
}: {
  messageData: MessageListResponse;
  selectedChannelId: string;
  onSelectChannel(channelId: string): void;
}) {
  return (
    <section className="filter-panel" aria-label="채널 필터">
      <VStack gap={2}>
        <Text type="label">채널 필터</Text>
        <Button
          label="전체"
          variant={!selectedChannelId ? "primary" : "secondary"}
          size="sm"
          endContent={<Badge label={messageData.total} variant={!selectedChannelId ? "info" : "neutral"} />}
          onClick={() => onSelectChannel("")}
        />
        {messageData.channels.map((channel) => (
          <Button
            key={channel.channelId}
            label={`#${channel.channelName ?? channel.channelId}`}
            variant={selectedChannelId === channel.channelId ? "primary" : "secondary"}
            size="sm"
            endContent={<Badge label={channel.count} variant={selectedChannelId === channel.channelId ? "info" : "neutral"} />}
            onClick={() => onSelectChannel(channel.channelId)}
          />
        ))}
      </VStack>
    </section>
  );
}

function SettingsPanel({ settings }: { settings: AppSettings | null }) {
  const allowlist = settings?.channelAllowlist.length ? settings.channelAllowlist.join(", ") : "미지정";
  return (
    <section className="settings-panel" aria-label="Discord 설정">
      <VStack gap={3}>
        <Heading level={2} accessibilityLevel={3}>
          설정
        </Heading>
        <dl>
          <SettingsRow label="토큰" value={settings?.discord.tokenConfigured ? "설정됨" : "없음"} />
          <SettingsRow label="채널 allowlist" value={allowlist} />
          <SettingsRow label="필요 권한" value={settings?.discord.requiredBotPermissions.join(", ") ?? "View Channels, Read Message History"} />
          <SettingsRow label="금지 권한" value={settings?.discord.disallowedBotPermissions.join(", ") ?? "Send Messages"} />
        </dl>
      </VStack>
    </section>
  );
}

function SettingsRow({ label, value }: { label: string; value: string }) {
  return (
    <HStack as="div" className="settings-row" justify="between" gap={3} align="start">
      <dt>
        <Text type="supporting">{label}</Text>
      </dt>
      <dd>
        <Text type="body" wordBreak="break-word">
          {value}
        </Text>
      </dd>
    </HStack>
  );
}

function MessageCard({ message }: { message: DiscordMessageRecord }) {
  return (
    <Card padding={4} variant={message.status === "deleted" ? "muted" : "default"} className="message-card">
      <VStack gap={3}>
        <HStack justify="between" align="start" gap={3} wrap="wrap">
          <VStack gap={0.5} className="minmax-panel">
            <Text type="label" maxLines={1}>
              {message.authorName}
            </Text>
            <Text type="supporting" maxLines={1}>
              #{message.channelName ?? message.channelId}
            </Text>
          </VStack>
          <HStack gap={2} align="center" wrap="wrap">
            <StatusBadge status={message.status} />
            <TranslationBadge message={message} />
          </HStack>
        </HStack>
        <VStack gap={1.5}>
          <Text type="label">원문</Text>
          <Text as="p" wordBreak="break-word">
            {message.contentOriginal || "삭제된 메시지입니다."}
          </Text>
        </VStack>
        <TranslationBlock message={message} />
        <HStack justify="between" align="center" gap={3} wrap="wrap">
          <Text type="supporting" hasTabularNumbers>
            {formatTime(message.createdAt)}
          </Text>
          <Button label="Discord에서 열기" href={message.deeplink} target="_blank" rel="noreferrer" size="sm" variant="ghost" />
        </HStack>
      </VStack>
    </Card>
  );
}

function TranslationBlock({ message }: { message: DiscordMessageRecord }) {
  if (message.translationKo) {
    return (
      <Card padding={3} variant="muted">
        <VStack gap={1.5}>
          <Text type="label">한국어 번역</Text>
          <Text as="p" wordBreak="break-word">
            {message.translationKo}
          </Text>
        </VStack>
      </Card>
    );
  }
  if (message.translationStatus === "skipped") {
    return (
      <Text type="supporting" color="secondary">
        한국어 원문으로 판단되어 번역을 건너뜀
      </Text>
    );
  }
  return (
    <Text type="supporting" color={message.translationError ? "accent" : "secondary"} wordBreak="break-word">
      {message.translationError ? `번역 재시도 대기: ${message.translationError}` : "한국어 번역 대기 중"}
    </Text>
  );
}

function StatusBadge({ status }: { status: DiscordMessageRecord["status"] }) {
  if (status === "deleted") return <Badge label="삭제됨" variant="error" />;
  if (status === "edited") return <Badge label="수정됨" variant="warning" />;
  return <Badge label="수집" variant="neutral" />;
}

function TranslationBadge({ message }: { message: DiscordMessageRecord }) {
  if (message.translationStatus === "translated") return <Badge label="번역됨" variant="info" />;
  if (message.translationStatus === "skipped") return <Badge label="번역 생략" variant="neutral" />;
  return <Badge label="번역 대기" variant="warning" />;
}

function StreamBadge({ state }: { state: DashboardProps["streamState"] }) {
  if (state === "connected") return <Badge label="실시간 연결" variant="success" />;
  if (state === "reconnecting") return <Badge label="재연결 중" variant="warning" />;
  return <Badge label="스트림 준비" variant="neutral" />;
}

function StatusNotice({ tone, message }: { tone: "warning"; message: string }) {
  return (
    <Card padding={3} variant={tone === "warning" ? "yellow" : "muted"}>
      <Text type="supporting" wordBreak="break-word">
        {message}
      </Text>
    </Card>
  );
}

function EmptyInbox() {
  return (
    <Card padding={5} variant="muted">
      <Text type="supporting">수집된 메시지가 없습니다.</Text>
    </Card>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}
