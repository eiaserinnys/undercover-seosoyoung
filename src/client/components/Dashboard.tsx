import type { AppSettings, DiscordMessageRecord, MessageListResponse } from "../../shared/types.js";

export interface DashboardProps {
  settings: AppSettings | null;
  messageData: MessageListResponse;
  selectedChannelId: string;
  error: string | null;
  onSelectChannel(channelId: string): void;
}

export function Dashboard({ settings, messageData, selectedChannelId, error, onSelectChannel }: DashboardProps) {
  const modeLabel = settings?.discord.mode === "live" ? "Live Gateway" : settings?.discord.mode === "configuration_error" ? "설정 확인 필요" : "Mock mode";
  return (
    <main className="dashboard-shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">Discord Ops</p>
          <h1>{settings?.dashboardTitle ?? "암행 서소영"}</h1>
        </div>
        <ReadOnlyBadge modeLabel={modeLabel} />
        <section className="filter-panel" aria-label="채널 필터">
          <button className={!selectedChannelId ? "filter active" : "filter"} type="button" onClick={() => onSelectChannel("")}>
            <span>전체</span>
            <strong>{messageData.total}</strong>
          </button>
          {messageData.channels.map((channel) => (
            <button
              key={channel.channelId}
              className={selectedChannelId === channel.channelId ? "filter active" : "filter"}
              type="button"
              onClick={() => onSelectChannel(channel.channelId)}
            >
              <span>#{channel.channelName ?? channel.channelId}</span>
              <strong>{channel.count}</strong>
            </button>
          ))}
        </section>
        <SettingsPanel settings={settings} />
      </aside>
      <section className="inbox" aria-label="Discord 메시지 인박스">
        <header className="inbox-header">
          <div>
            <p className="eyebrow">Read-only collector</p>
            <h2>원문 인박스</h2>
          </div>
          <span className="counter">{messageData.messages.length}개 표시</span>
        </header>
        {error ? <div className="notice error">{error}</div> : null}
        {settings?.discord.configErrors.length ? (
          <div className="notice warning">{settings.discord.configErrors.join(", ")}</div>
        ) : null}
        <div className="message-list">
          {messageData.messages.map((message) => (
            <MessageCard key={message.messageId} message={message} />
          ))}
          {messageData.messages.length === 0 ? <div className="empty">수집된 메시지가 없습니다.</div> : null}
        </div>
      </section>
    </main>
  );
}

function ReadOnlyBadge({ modeLabel }: { modeLabel: string }) {
  return (
    <section className="readonly-panel" aria-label="읽기 전용 상태">
      <div className="status-dot" />
      <div>
        <strong>읽기 전용</strong>
        <span>Discord에 쓰지 않음 · {modeLabel}</span>
      </div>
    </section>
  );
}

function SettingsPanel({ settings }: { settings: AppSettings | null }) {
  const allowlist = settings?.channelAllowlist.length ? settings.channelAllowlist.join(", ") : "미지정";
  return (
    <section className="settings-panel" aria-label="Discord 설정">
      <h2>설정</h2>
      <dl>
        <div>
          <dt>토큰</dt>
          <dd>{settings?.discord.tokenConfigured ? "설정됨" : "없음"}</dd>
        </div>
        <div>
          <dt>채널 allowlist</dt>
          <dd>{allowlist}</dd>
        </div>
        <div>
          <dt>필요 권한</dt>
          <dd>{settings?.discord.requiredBotPermissions.join(", ") ?? "View Channels, Read Message History"}</dd>
        </div>
        <div>
          <dt>금지 권한</dt>
          <dd>{settings?.discord.disallowedBotPermissions.join(", ") ?? "Send Messages"}</dd>
        </div>
      </dl>
    </section>
  );
}

function MessageCard({ message }: { message: DiscordMessageRecord }) {
  return (
    <article className={`message-card ${message.status === "deleted" ? "deleted" : ""}`}>
      <header>
        <div>
          <strong>{message.authorName}</strong>
          <span>#{message.channelName ?? message.channelId}</span>
        </div>
        <StatusPill status={message.status} />
      </header>
      <p>{message.contentOriginal || "삭제된 메시지입니다."}</p>
      <footer>
        <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
        <a href={message.deeplink} target="_blank" rel="noreferrer">
          Discord에서 열기
        </a>
      </footer>
    </article>
  );
}

function StatusPill({ status }: { status: DiscordMessageRecord["status"] }) {
  const label = status === "deleted" ? "삭제됨" : status === "edited" ? "수정됨" : "원문";
  return <span className={`status-pill ${status}`}>{label}</span>;
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
