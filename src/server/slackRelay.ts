import type { DiscordMessageRecord } from "../shared/types.js";
import type { SlackRelayJob } from "./slackRelayStore.js";
import { SlackRelayStore } from "./slackRelayStore.js";

export interface SlackTablePayload {
  blocks: Array<{
    type: "table";
    column_settings: Array<{ is_wrapped: boolean }>;
    rows: Array<Array<
      | { type: "raw_text"; text: string }
      | { type: "rich_text"; elements: Array<{ type: "rich_text_section"; elements: Array<{ type: "link"; url: string; text: string }> }> }
    >>;
  }>;
  unfurl_links: false;
  unfurl_media: false;
}

export interface SlackClient {
  authTest(): Promise<{ userId: string }>;
  postMessage(channel: string, payload: SlackTablePayload): Promise<{ channel: string; ts: string }>;
  updateMessage(channel: string, ts: string, payload: SlackTablePayload): Promise<{ channel: string; ts: string }>;
  deleteMessage(channel: string, ts: string): Promise<{ channel: string; ts: string }>;
}

export interface SlackRelayServiceConfig {
  channelId: string;
  botUserId: string;
  minWriteIntervalMs?: number;
}

export class AmbiguousSlackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousSlackError";
  }
}

export class SlackRateLimitError extends Error {
  constructor(message: string, readonly retryAfterMs: number) {
    super(message);
    this.name = "SlackRateLimitError";
  }
}

export class SlackApiError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "SlackApiError";
  }
}

export class SlackWebApiClient implements SlackClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15_000
  ) {}

  async authTest(): Promise<{ userId: string }> {
    const body = await this.request("auth.test", {}, false);
    const userId = stringValue(body.user_id);
    if (!userId) throw new SlackApiError("Slack auth.test did not return user_id", "invalid_auth_response");
    return { userId };
  }

  async postMessage(channel: string, payload: SlackTablePayload): Promise<{ channel: string; ts: string }> {
    const body = await this.request("chat.postMessage", { channel, ...payload }, true);
    try {
      return responseIdentity(body);
    } catch (error) {
      throw new AmbiguousSlackError(error instanceof Error ? error.message : "Slack post response was invalid");
    }
  }

  async updateMessage(channel: string, ts: string, payload: SlackTablePayload): Promise<{ channel: string; ts: string }> {
    const body = await this.request("chat.update", { channel, ts, ...payload }, false);
    return responseIdentity(body);
  }

  async deleteMessage(channel: string, ts: string): Promise<{ channel: string; ts: string }> {
    const body = await this.request("chat.delete", { channel, ts }, false);
    return responseIdentity(body, channel, ts);
  }

  private async request(
    method: string,
    payload: Record<string, unknown>,
    ambiguousOnTransportFailure: boolean
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`https://slack.com/api/${method}`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Slack transport failed";
        if (ambiguousOnTransportFailure) throw new AmbiguousSlackError(message);
        throw error;
      }
      if (response.status === 429) {
        const parsedRetryAfter = Number.parseInt(response.headers.get("retry-after") ?? "1", 10);
        const retryAfterSeconds = Number.isFinite(parsedRetryAfter) ? Math.max(1, parsedRetryAfter) : 1;
        throw new SlackRateLimitError("Slack rate limit exceeded", retryAfterSeconds * 1_000);
      }
      if (response.status >= 500 && ambiguousOnTransportFailure) {
        throw new AmbiguousSlackError(`Slack ${method} returned HTTP ${response.status}`);
      }
      if (!response.ok) throw new SlackApiError(`Slack ${method} returned HTTP ${response.status}`, `http_${response.status}`);
      const body = await response.json() as Record<string, unknown>;
      if (body.ok !== true) {
        const code = stringValue(body.error) || "unknown_error";
        throw new SlackApiError(`Slack ${method} failed: ${code}`, code);
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class SlackRelayService {
  private started = false;
  private stopped = false;
  private draining = false;
  private drainPromise: Promise<void> | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryTimerDueAt = 0;
  private lastWriteAt = 0;

  constructor(
    private readonly store: SlackRelayStore,
    private readonly client: SlackClient,
    private readonly config: SlackRelayServiceConfig
  ) {}

  initialize(): void {
    this.store.initializeBaseline();
    this.store.reconcile();
  }

  async start(): Promise<void> {
    const auth = await this.client.authTest();
    if (auth.userId !== this.config.botUserId) {
      throw new Error(`Slack auth.test user_id mismatch: expected ${this.config.botUserId}, got ${auth.userId}`);
    }
    this.started = true;
    this.stopped = false;
    await this.drain();
  }

  handleMessageChange(messageId: string): void {
    this.store.observeMessage(messageId);
    if (this.started && !this.stopped) this.scheduleDrain();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryTimerDueAt = 0;
    await this.drainPromise;
  }

  private scheduleDrain(): void {
    if (this.draining || this.stopped || !this.started) return;
    queueMicrotask(() => { void this.drain(); });
  }

  private async drain(): Promise<void> {
    if (this.draining || this.stopped || !this.started) return;
    this.draining = true;
    const running = (async () => {
      try {
        while (!this.stopped) {
          const job = this.store.nextReady();
          if (!job) {
            this.scheduleNextDurableRetry();
            break;
          }
          await this.deliver(job);
        }
      } finally {
        this.draining = false;
        this.drainPromise = null;
      }
    })();
    this.drainPromise = running;
    await running;
  }

  private async deliver(job: SlackRelayJob): Promise<void> {
    let postReturned = false;
    try {
      let response: { channel: string; ts: string };
      if (job.pendingAction === "delete") {
        if (!job.slackTs) throw new Error("Cannot delete Slack message without a timestamp");
        await this.waitForWriteSlot();
        response = await this.client.deleteMessage(this.config.channelId, job.slackTs);
        validateSlackIdentity(response, this.config.channelId);
        this.store.markDelivered(job.messageId, null);
        return;
      }

      const payload = buildSlackTablePayload(job.message);
      const characterCount = relayCharacterCount(job.message);
      if (characterCount > 10_000) {
        const error = `Slack table content is ${characterCount} characters (limit 10000)`;
        this.store.markTooLong(job.messageId, error);
        console.error("Slack relay message requires operator review", { messageId: job.messageId, status: "too_long", error });
        return;
      }
      await this.waitForWriteSlot();
      if (job.pendingAction === "post") {
        response = await this.client.postMessage(this.config.channelId, payload);
        postReturned = true;
      } else {
        if (!job.slackTs) throw new Error("Cannot update Slack message without a timestamp");
        response = await this.client.updateMessage(this.config.channelId, job.slackTs, payload);
      }
      validateSlackIdentity(response, this.config.channelId);
      this.store.markDelivered(job.messageId, response.ts);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Slack relay failed";
      if ((error instanceof AmbiguousSlackError || postReturned) && job.pendingAction === "post") {
        this.store.markUnknown(job.messageId, message);
        console.error("Slack relay post result is unknown; automatic retry is paused", {
          messageId: job.messageId,
          status: "unknown",
          error: message
        });
        return;
      }
      if (job.pendingAction === "delete" && error instanceof SlackApiError && error.code === "message_not_found") {
        this.store.markDelivered(job.messageId, null);
        return;
      }
      const retryMs = error instanceof SlackRateLimitError
        ? error.retryAfterMs
        : Math.min(300_000, 1_000 * 2 ** Math.min(job.attemptCount, 8));
      const nextAttemptAt = new Date(Date.now() + retryMs).toISOString();
      this.store.markRetry(job.messageId, message, nextAttemptAt);
      console.error("Slack relay write failed and will be retried", {
        messageId: job.messageId,
        action: job.pendingAction,
        nextAttemptAt,
        error: message
      });
    }
  }

  private scheduleNextDurableRetry(): void {
    const nextRetryAt = this.store.nextRetryAt();
    if (!nextRetryAt || this.stopped) {
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.retryTimerDueAt = 0;
      return;
    }
    const dueAt = Date.parse(nextRetryAt);
    if (!Number.isFinite(dueAt)) return;
    if (this.retryTimer && this.retryTimerDueAt <= dueAt) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimerDueAt = dueAt;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryTimerDueAt = 0;
      this.scheduleDrain();
    }, Math.max(0, dueAt - Date.now()));
    this.retryTimer.unref?.();
  }

  private async waitForWriteSlot(): Promise<void> {
    const interval = this.config.minWriteIntervalMs ?? 1_000;
    const waitMs = Math.max(0, this.lastWriteAt + interval - Date.now());
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    this.lastWriteAt = Date.now();
  }
}

export function buildSlackTablePayload(message: DiscordMessageRecord): SlackTablePayload {
  const korean = message.translationKo ?? message.contentOriginal;
  return {
    blocks: [{
      type: "table",
      column_settings: [{ is_wrapped: false }, { is_wrapped: true }, { is_wrapped: true }],
      rows: [[
        {
          type: "rich_text",
          elements: [{
            type: "rich_text_section",
            elements: [{ type: "link", url: message.deeplink, text: `🔗 ${message.authorName}` }]
          }]
        },
        { type: "raw_text", text: korean },
        { type: "raw_text", text: message.contentOriginal }
      ]]
    }],
    unfurl_links: false,
    unfurl_media: false
  };
}

function relayCharacterCount(message: DiscordMessageRecord): number {
  return [...`🔗 ${message.authorName}${message.translationKo ?? message.contentOriginal}${message.contentOriginal}`].length;
}

function validateSlackIdentity(response: { channel: string; ts: string }, expectedChannel: string): void {
  if (response.channel !== expectedChannel) {
    throw new Error(`Slack response channel mismatch: expected ${expectedChannel}, got ${response.channel}`);
  }
  if (!response.ts.trim()) throw new Error("Slack response did not include a message timestamp");
}

function responseIdentity(body: Record<string, unknown>, fallbackChannel = "", fallbackTs = ""): { channel: string; ts: string } {
  const channel = stringValue(body.channel) || fallbackChannel;
  const ts = stringValue(body.ts) || fallbackTs;
  if (!channel || !ts) throw new SlackApiError("Slack response did not include channel and ts", "invalid_response");
  return { channel, ts };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
