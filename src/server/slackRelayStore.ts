import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { DiscordMessageRecord, DiscordMessageStatus, TranslationStatus } from "../shared/types.js";

export type SlackRelayAction = "post" | "update" | "delete";
export type SlackRelayStatus =
  | "baseline_excluded"
  | "waiting"
  | "pending"
  | "processing"
  | "sent"
  | "failed"
  | "unknown"
  | "too_long"
  | "empty";

export interface SlackRelayState {
  messageId: string;
  eligible: boolean;
  status: SlackRelayStatus;
  pendingAction: SlackRelayAction | null;
  observedRevision: string;
  attemptedRevision: string | null;
  deliveredRevision: string | null;
  slackTs: string | null;
  attemptCount: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  updatedAt: string;
}

export interface SlackRelayJob extends SlackRelayState {
  pendingAction: SlackRelayAction;
  message: DiscordMessageRecord;
}

export class SlackRelayStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initializeSchema();
  }

  close(): void {
    this.db.close();
  }

  initializeBaseline(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const initialized = this.db.prepare("SELECT value FROM slack_relay_meta WHERE key = 'baseline_initialized'").get();
      if (!initialized) {
        const timestamp = new Date().toISOString();
        this.db.prepare(
          `
          INSERT OR IGNORE INTO slack_relay_state (
            message_id, eligible, status, pending_action, observed_revision,
            attempted_revision, delivered_revision, slack_ts, attempt_count,
            last_error, next_attempt_at, updated_at
          )
          SELECT message_id, 0, 'baseline_excluded', NULL, '', NULL, NULL, NULL, 0, NULL, NULL, ?
          FROM discord_messages
        `
        ).run(timestamp);
        this.db.prepare("INSERT INTO slack_relay_meta (key, value) VALUES ('baseline_initialized', ?)").run(timestamp);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  reconcile(): void {
    this.initializeBaseline();
    const now = new Date().toISOString();
    // A crash during a post leaves delivery ambiguous; updates and deletes are
    // addressable and can safely be retried.
    this.db.prepare(
      `
      UPDATE slack_relay_state
      SET status = CASE WHEN pending_action = 'post' THEN 'unknown' ELSE 'pending' END,
          last_error = CASE WHEN pending_action = 'post' THEN 'process stopped during Slack post' ELSE last_error END,
          next_attempt_at = NULL,
          updated_at = ?
      WHERE status = 'processing' AND eligible = 1
    `
    ).run(now);
    const rows = this.db.prepare("SELECT message_id FROM discord_messages ORDER BY received_at, message_id").all();
    for (const row of rows) this.observeMessage(text(row.message_id));
  }

  observeMessage(messageId: string): SlackRelayState | null {
    const message = this.getMessage(messageId);
    if (!message) return null;
    let state = this.getState(messageId);
    const now = new Date().toISOString();
    if (!state) {
      if (!this.isBaselineInitialized()) {
        throw new Error("Slack relay baseline must be initialized before observing messages");
      }
      this.db.prepare(
        `
        INSERT INTO slack_relay_state (
          message_id, eligible, status, pending_action, observed_revision,
          attempted_revision, delivered_revision, slack_ts, attempt_count,
          last_error, next_attempt_at, updated_at
        ) VALUES (?, 1, 'waiting', NULL, '', NULL, NULL, NULL, 0, NULL, NULL, ?)
      `
      ).run(messageId, now);
      state = this.getState(messageId);
    }
    if (!state || !state.eligible) return state;

    const revision = relayRevision(message);
    if (state.status === "processing" && state.observedRevision === revision) return state;
    if ((state.status === "failed" || state.status === "too_long") && state.observedRevision === revision) return state;
    if (state.status === "unknown") {
      this.db.prepare("UPDATE slack_relay_state SET observed_revision = ?, updated_at = ? WHERE message_id = ?")
        .run(revision, now, messageId);
      return this.getState(messageId);
    }
    let status: SlackRelayStatus;
    let action: SlackRelayAction | null;
    let deliveredRevision = state.deliveredRevision;
    let slackTs = state.slackTs;
    if (message.status === "deleted") {
      if (slackTs) {
        status = "pending";
        action = "delete";
      } else {
        status = "sent";
        action = null;
        deliveredRevision = revision;
      }
    } else if (!message.contentOriginal.trim()) {
      status = "empty";
      action = null;
      if (state.status !== "empty" || state.observedRevision !== revision) {
        console.error("Slack relay skipped an empty Discord message", { messageId });
      }
    } else if (!isTranslationReady(message)) {
      status = "waiting";
      action = null;
    } else if (!slackTs) {
      status = "pending";
      action = "post";
    } else if (deliveredRevision !== revision) {
      status = "pending";
      action = "update";
    } else {
      status = "sent";
      action = null;
    }

    this.db.prepare(
      `
      UPDATE slack_relay_state
      SET status = ?, pending_action = ?, observed_revision = ?, delivered_revision = ?,
          slack_ts = ?, last_error = NULL, next_attempt_at = NULL, updated_at = ?
      WHERE message_id = ?
    `
    ).run(status, action, revision, deliveredRevision, slackTs, now, messageId);
    return this.getState(messageId);
  }

  nextReady(now = new Date().toISOString()): SlackRelayJob | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(
        `
        SELECT * FROM slack_relay_state
        WHERE eligible = 1
          AND status IN ('pending', 'failed')
          AND pending_action IS NOT NULL
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY updated_at, message_id
        LIMIT 1
      `
      ).get(now) as Record<string, unknown> | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }
      const state = mapState(row);
      this.db.prepare(
        `
        UPDATE slack_relay_state
        SET status = 'processing', attempted_revision = observed_revision,
            attempt_count = attempt_count + 1, updated_at = ?
        WHERE message_id = ?
      `
      ).run(now, state.messageId);
      this.db.exec("COMMIT");
      const claimed = this.getState(state.messageId);
      const message = this.getMessage(state.messageId);
      if (!claimed?.pendingAction || !message) return null;
      return { ...claimed, pendingAction: claimed.pendingAction, message };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  nextRetryAt(): string | null {
    const row = this.db.prepare(
      `
      SELECT MIN(next_attempt_at) AS next_attempt_at
      FROM slack_relay_state
      WHERE eligible = 1
        AND status = 'failed'
        AND pending_action IS NOT NULL
        AND next_attempt_at IS NOT NULL
    `
    ).get() as Record<string, unknown> | undefined;
    return nullableText(row?.next_attempt_at);
  }

  markDelivered(messageId: string, slackTs: string | null): void {
    const state = this.getState(messageId);
    if (!state) return;
    const now = new Date().toISOString();
    const nextSlackTs = state.pendingAction === "delete" ? null : (slackTs ?? state.slackTs);
    this.db.prepare(
      `
      UPDATE slack_relay_state
      SET status = 'sent', pending_action = NULL, delivered_revision = attempted_revision,
          slack_ts = ?, last_error = NULL, next_attempt_at = NULL, updated_at = ?
      WHERE message_id = ?
    `
    ).run(nextSlackTs, now, messageId);
    this.observeMessage(messageId);
  }

  markRetry(messageId: string, error: string, nextAttemptAt: string): void {
    this.db.prepare(
      `
      UPDATE slack_relay_state
      SET status = 'failed', last_error = ?, next_attempt_at = ?, updated_at = ?
      WHERE message_id = ?
    `
    ).run(error, nextAttemptAt, new Date().toISOString(), messageId);
  }

  markUnknown(messageId: string, error: string): void {
    this.db.prepare(
      `
      UPDATE slack_relay_state
      SET status = 'unknown', last_error = ?, next_attempt_at = NULL, updated_at = ?
      WHERE message_id = ?
    `
    ).run(error, new Date().toISOString(), messageId);
  }

  markTooLong(messageId: string, error: string): void {
    this.db.prepare(
      `
      UPDATE slack_relay_state
      SET status = 'too_long', pending_action = NULL, last_error = ?, next_attempt_at = NULL, updated_at = ?
      WHERE message_id = ?
    `
    ).run(error, new Date().toISOString(), messageId);
  }

  getState(messageId: string): SlackRelayState | null {
    const row = this.db.prepare("SELECT * FROM slack_relay_state WHERE message_id = ?").get(messageId);
    return row ? mapState(row as Record<string, unknown>) : null;
  }

  private initializeSchema(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS slack_relay_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS slack_relay_state (
        message_id TEXT PRIMARY KEY,
        eligible INTEGER NOT NULL,
        status TEXT NOT NULL,
        pending_action TEXT,
        observed_revision TEXT NOT NULL,
        attempted_revision TEXT,
        delivered_revision TEXT,
        slack_ts TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_attempt_at TEXT,
        updated_at TEXT NOT NULL
      );
        CREATE INDEX IF NOT EXISTS idx_slack_relay_ready
          ON slack_relay_state(status, next_attempt_at, updated_at);
      `);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private isBaselineInitialized(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM slack_relay_meta WHERE key = 'baseline_initialized'").get());
  }

  private getMessage(messageId: string): DiscordMessageRecord | null {
    const row = this.db.prepare("SELECT * FROM discord_messages WHERE message_id = ?").get(messageId);
    return row ? mapMessage(row as Record<string, unknown>) : null;
  }
}

function isTranslationReady(message: DiscordMessageRecord): boolean {
  return message.translationStatus === "translated" || message.translationStatus === "skipped";
}

function relayRevision(message: DiscordMessageRecord): string {
  return createHash("sha256").update(JSON.stringify({
    authorName: message.authorName,
    contentOriginal: message.contentOriginal,
    translationKo: message.translationKo,
    translationStatus: message.translationStatus,
    deeplink: message.deeplink,
    status: message.status
  })).digest("hex");
}

function mapState(row: Record<string, unknown>): SlackRelayState {
  return {
    messageId: text(row.message_id),
    eligible: Number(row.eligible) === 1,
    status: text(row.status) as SlackRelayStatus,
    pendingAction: nullableText(row.pending_action) as SlackRelayAction | null,
    observedRevision: text(row.observed_revision),
    attemptedRevision: nullableText(row.attempted_revision),
    deliveredRevision: nullableText(row.delivered_revision),
    slackTs: nullableText(row.slack_ts),
    attemptCount: Number(row.attempt_count ?? 0),
    lastError: nullableText(row.last_error),
    nextAttemptAt: nullableText(row.next_attempt_at),
    updatedAt: text(row.updated_at)
  };
}

function mapMessage(row: Record<string, unknown>): DiscordMessageRecord {
  return {
    guildId: text(row.guild_id), channelId: text(row.channel_id), channelName: nullableText(row.channel_name),
    parentChannelId: nullableText(row.parent_channel_id), threadId: nullableText(row.thread_id),
    messageId: text(row.message_id), authorId: text(row.author_id), authorName: text(row.author_name),
    authorAvatarUrl: nullableText(row.author_avatar_url), contentOriginal: text(row.content_original),
    translationKo: nullableText(row.translation_ko), translationStatus: text(row.translation_status) as TranslationStatus,
    translationError: nullableText(row.translation_error), translatedAt: nullableText(row.translated_at),
    deeplink: text(row.deeplink), status: text(row.status) as DiscordMessageStatus,
    detectedLanguage: nullableText(row.detected_language), replyState: text(row.reply_state) as DiscordMessageRecord["replyState"],
    createdAt: text(row.created_at), editedAt: nullableText(row.edited_at), deletedAt: nullableText(row.deleted_at),
    receivedAt: text(row.received_at)
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
