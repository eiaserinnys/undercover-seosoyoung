import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  DiscordAttachmentRecord,
  DiscordMessageRecord,
  DiscordMessageStatus,
  TranslationStatus
} from "../shared/types.js";
import { attachmentRevisionSource, parseDiscordAttachments } from "./discordAttachments.js";

export type SlackRelayAction = "post" | "update" | "delete" | "media";
export type SlackAttachmentRelayStatus = "pending" | "processing" | "uploaded" | "failed" | "unknown" | "deleted";
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

export interface SlackAttachmentRelayState {
  messageId: string;
  attachmentId: string;
  sourceRevision: string;
  status: SlackAttachmentRelayStatus;
  slackFileId: string | null;
  lastError: string | null;
  updatedAt: string;
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
    // A crash during a parent post or file completion can be ambiguous. Never
    // repeat those writes automatically; attachment fallback is deterministic.
    this.db.prepare(
      `
      UPDATE slack_relay_attachments
      SET status = 'unknown', last_error = 'process stopped during Slack file upload', updated_at = ?
      WHERE status = 'processing'
    `
    ).run(now);
    this.db.prepare(
      `
      UPDATE slack_relay_state
      SET status = CASE WHEN pending_action = 'post' AND slack_ts IS NULL THEN 'unknown' ELSE 'pending' END,
          pending_action = CASE WHEN pending_action = 'post' AND slack_ts IS NOT NULL THEN 'media' ELSE pending_action END,
          last_error = CASE
            WHEN pending_action = 'post' AND slack_ts IS NULL THEN 'process stopped during Slack post'
            ELSE last_error
          END,
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

    this.syncAttachmentStates(message, now);

    const revision = relayRevision(message);
    if (state.status === "processing" && state.observedRevision === revision) return state;
    if (state.pendingAction === "media" && state.observedRevision === revision) return state;
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
    } else if (!message.contentOriginal.trim() && message.attachments.length === 0) {
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

  markParentWritten(
    messageId: string,
    slackTs: string,
    expectedRevision: string,
    expectedAction: Extract<SlackRelayAction, "post" | "update">
  ): boolean {
    const state = this.getState(messageId);
    if (!state) return false;
    const message = this.getMessage(messageId);
    const now = new Date().toISOString();
    if (!isCurrentAttempt(state, expectedRevision, expectedAction)
      || !message
      || relayRevision(message) !== expectedRevision) {
      // A successful post must remain addressable even when a newer Discord
      // event arrived while the Slack request was in flight. Re-observing then
      // turns that newer event into an update or delete instead of a duplicate post.
      if (expectedAction === "post") {
        this.db.prepare(
          `UPDATE slack_relay_state SET slack_ts = COALESCE(slack_ts, ?), updated_at = ? WHERE message_id = ?`
        ).run(slackTs, now, messageId);
      }
      this.observeMessage(messageId);
      return false;
    }
    if (!message || message.attachments.length === 0) {
      return this.markDelivered(messageId, slackTs, expectedRevision, expectedAction);
    }
    this.syncAttachmentStates(message, now);
    const result = this.db.prepare(
      `
      UPDATE slack_relay_state
      SET status = 'pending', pending_action = 'media', slack_ts = ?,
          last_error = NULL, next_attempt_at = NULL, updated_at = ?
      WHERE message_id = ? AND status = 'processing'
        AND attempted_revision = ? AND observed_revision = ? AND pending_action = ?
    `
    ).run(slackTs, now, messageId, expectedRevision, expectedRevision, expectedAction);
    return result.changes === 1;
  }

  claimPendingAttachments(messageId: string): DiscordAttachmentRecord[] {
    const message = this.getMessage(messageId);
    if (!message) return [];
    this.syncAttachmentStates(message);
    const pendingIds = new Set(this.db.prepare(
      `SELECT attachment_id FROM slack_relay_attachments WHERE message_id = ? AND status = 'pending'`
    ).all(messageId).map((row) => text(row.attachment_id)));
    const claimedAttachments = message.attachments.filter((attachment) => pendingIds.has(attachment.attachmentId));
    if (claimedAttachments.length === 0) return [];
    const now = new Date().toISOString();
    const update = this.db.prepare(
      `
      UPDATE slack_relay_attachments
      SET status = 'processing', slack_file_id = NULL, last_error = NULL, updated_at = ?
      WHERE message_id = ? AND attachment_id = ? AND status = 'pending'
    `
    );
    for (const attachment of claimedAttachments) update.run(now, messageId, attachment.attachmentId);
    return claimedAttachments;
  }

  markAttachmentsUploaded(messageId: string, files: Array<{ attachmentId: string; slackFileId: string }>): void {
    const now = new Date().toISOString();
    const update = this.db.prepare(
      `
      UPDATE slack_relay_attachments
      SET status = 'uploaded', slack_file_id = ?, last_error = NULL, updated_at = ?
      WHERE message_id = ? AND attachment_id = ? AND status = 'processing'
    `
    );
    for (const file of files) update.run(file.slackFileId, now, messageId, file.attachmentId);
  }

  markAttachmentPrepared(messageId: string, attachmentId: string, slackFileId: string): void {
    this.db.prepare(
      `
      UPDATE slack_relay_attachments
      SET slack_file_id = ?, updated_at = ?
      WHERE message_id = ? AND attachment_id = ? AND status = 'processing'
    `
    ).run(slackFileId, new Date().toISOString(), messageId, attachmentId);
  }

  markAttachmentsFailed(
    messageId: string,
    attachmentIds: string[],
    error: string,
    status: Extract<SlackAttachmentRelayStatus, "failed" | "unknown"> = "failed"
  ): void {
    const now = new Date().toISOString();
    const update = this.db.prepare(
      `
      UPDATE slack_relay_attachments
      SET status = ?,
          slack_file_id = CASE WHEN ? = 'unknown' THEN slack_file_id ELSE NULL END,
          last_error = ?, updated_at = ?
      WHERE message_id = ? AND attachment_id = ? AND status = 'processing'
    `
    );
    for (const attachmentId of attachmentIds) update.run(status, status, error, now, messageId, attachmentId);
  }

  fallbackAttachments(messageId: string): DiscordAttachmentRecord[] {
    const message = this.getMessage(messageId);
    if (!message) return [];
    const rows = this.db.prepare(
      `
      SELECT attachment_id FROM slack_relay_attachments
      WHERE message_id = ? AND status IN ('failed', 'unknown')
    `
    ).all(messageId);
    const failed = new Set(rows.map((row) => text(row.attachment_id)));
    return message.attachments.filter((attachment) => failed.has(attachment.attachmentId));
  }

  getAttachmentState(messageId: string, attachmentId: string): SlackAttachmentRelayState | null {
    const row = this.db.prepare(
      "SELECT * FROM slack_relay_attachments WHERE message_id = ? AND attachment_id = ?"
    ).get(messageId, attachmentId);
    return row ? mapAttachmentState(row as Record<string, unknown>) : null;
  }

  slackFilesForDelete(messageId: string): Array<{ attachmentId: string; slackFileId: string }> {
    const rows = this.db.prepare(
      `
      SELECT attachment_id, slack_file_id
      FROM slack_relay_attachments
      WHERE message_id = ?
        AND slack_file_id IS NOT NULL
        AND status IN ('processing', 'uploaded', 'unknown')
      ORDER BY attachment_id
    `
    ).all(messageId) as Record<string, unknown>[];
    return rows.map((row) => ({
      attachmentId: text(row.attachment_id),
      slackFileId: text(row.slack_file_id)
    }));
  }

  markAttachmentDeleted(messageId: string, attachmentId: string, slackFileId: string): void {
    this.db.prepare(
      `
      UPDATE slack_relay_attachments
      SET status = 'deleted', last_error = NULL, updated_at = ?
      WHERE message_id = ? AND attachment_id = ? AND slack_file_id = ?
        AND status IN ('processing', 'uploaded', 'unknown')
    `
    ).run(new Date().toISOString(), messageId, attachmentId, slackFileId);
  }

  markDelivered(
    messageId: string,
    slackTs: string | null,
    expectedRevision: string,
    expectedAction: SlackRelayAction
  ): boolean {
    const state = this.getState(messageId);
    if (!state) return false;
    const now = new Date().toISOString();
    if (!isCurrentAttempt(state, expectedRevision, expectedAction)) {
      if (expectedAction === "delete") {
        this.db.prepare("UPDATE slack_relay_state SET slack_ts = NULL, updated_at = ? WHERE message_id = ?")
          .run(now, messageId);
      }
      this.observeMessage(messageId);
      return false;
    }
    const nextSlackTs = expectedAction === "delete" ? null : (slackTs ?? state.slackTs);
    const result = this.db.prepare(
      `
      UPDATE slack_relay_state
      SET status = 'sent', pending_action = NULL, delivered_revision = ?,
          slack_ts = ?, last_error = NULL, next_attempt_at = NULL, updated_at = ?
      WHERE message_id = ? AND status = 'processing'
        AND attempted_revision = ? AND observed_revision = ? AND pending_action = ?
    `
    ).run(expectedRevision, nextSlackTs, now, messageId, expectedRevision, expectedRevision, expectedAction);
    this.observeMessage(messageId);
    return result.changes === 1;
  }

  markRetry(
    messageId: string,
    error: string,
    nextAttemptAt: string,
    expectedRevision: string,
    expectedAction: SlackRelayAction
  ): boolean {
    const result = this.db.prepare(
      `
      UPDATE slack_relay_state
      SET status = 'failed', last_error = ?, next_attempt_at = ?, updated_at = ?
      WHERE message_id = ? AND status = 'processing'
        AND attempted_revision = ? AND observed_revision = ? AND pending_action = ?
    `
    ).run(error, nextAttemptAt, new Date().toISOString(), messageId, expectedRevision, expectedRevision, expectedAction);
    if (result.changes === 0) this.observeMessage(messageId);
    return result.changes === 1;
  }

  markUnknown(messageId: string, error: string, expectedRevision: string, expectedAction: SlackRelayAction): boolean {
    const state = this.getState(messageId);
    if (!state) return false;
    // An ambiguous post may exist without a timestamp. Even if Discord changed
    // concurrently, pausing for operator confirmation is safer than posting again.
    if (!isCurrentAttempt(state, expectedRevision, expectedAction) && expectedAction !== "post") {
      this.observeMessage(messageId);
      return false;
    }
    const result = this.db.prepare(
      `
      UPDATE slack_relay_state
      SET status = 'unknown', last_error = ?, next_attempt_at = NULL, updated_at = ?
      WHERE message_id = ?
    `
    ).run(error, new Date().toISOString(), messageId);
    return result.changes === 1;
  }

  markTooLong(messageId: string, error: string, expectedRevision: string, expectedAction: SlackRelayAction): boolean {
    const result = this.db.prepare(
      `
      UPDATE slack_relay_state
      SET status = 'too_long', pending_action = NULL, last_error = ?, next_attempt_at = NULL, updated_at = ?
      WHERE message_id = ? AND status = 'processing'
        AND attempted_revision = ? AND observed_revision = ? AND pending_action = ?
    `
    ).run(error, new Date().toISOString(), messageId, expectedRevision, expectedRevision, expectedAction);
    if (result.changes === 0) this.observeMessage(messageId);
    return result.changes === 1;
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
      CREATE TABLE IF NOT EXISTS slack_relay_attachments (
        message_id TEXT NOT NULL,
        attachment_id TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        status TEXT NOT NULL,
        slack_file_id TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (message_id, attachment_id)
      );
        CREATE INDEX IF NOT EXISTS idx_slack_relay_ready
          ON slack_relay_state(status, next_attempt_at, updated_at);
        CREATE INDEX IF NOT EXISTS idx_slack_relay_attachments_status
          ON slack_relay_attachments(message_id, status);
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

  private syncAttachmentStates(message: DiscordMessageRecord, now = new Date().toISOString()): void {
    const existing = this.db.prepare(
      "SELECT * FROM slack_relay_attachments WHERE message_id = ? AND attachment_id = ?"
    );
    const insert = this.db.prepare(
      `
      INSERT INTO slack_relay_attachments (
        message_id, attachment_id, source_revision, status, slack_file_id, last_error, updated_at
      ) VALUES (?, ?, ?, 'pending', NULL, NULL, ?)
    `
    );
    const reset = this.db.prepare(
      `
      UPDATE slack_relay_attachments
      SET source_revision = ?, status = 'pending', slack_file_id = NULL, last_error = NULL, updated_at = ?
      WHERE message_id = ? AND attachment_id = ?
    `
    );
    for (const attachment of message.attachments) {
      const revision = attachmentRevision(attachment);
      const row = existing.get(message.messageId, attachment.attachmentId) as Record<string, unknown> | undefined;
      if (!row) {
        insert.run(message.messageId, attachment.attachmentId, revision, now);
      } else if (text(row.source_revision) !== revision) {
        reset.run(revision, now, message.messageId, attachment.attachmentId);
      }
    }
  }
}

function isTranslationReady(message: DiscordMessageRecord): boolean {
  return message.translationStatus === "translated" || message.translationStatus === "skipped";
}

function relayRevision(message: DiscordMessageRecord): string {
  return createHash("sha256").update(JSON.stringify({
    authorName: message.authorName,
    channelName: message.channelName,
    contentOriginal: message.contentOriginal,
    translationKo: message.translationKo,
    translationStatus: message.translationStatus,
    attachments: message.attachments.map(attachmentRevisionSource),
    deeplink: message.deeplink,
    status: message.status
  })).digest("hex");
}

function attachmentRevision(attachment: DiscordAttachmentRecord): string {
  return createHash("sha256").update(JSON.stringify(attachmentRevisionSource(attachment))).digest("hex");
}

function isCurrentAttempt(
  state: SlackRelayState,
  expectedRevision: string,
  expectedAction: SlackRelayAction
): boolean {
  return state.status === "processing"
    && state.attemptedRevision === expectedRevision
    && state.observedRevision === expectedRevision
    && state.pendingAction === expectedAction;
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
    attachments: parseDiscordAttachments(row.attachments_json),
    translationKo: nullableText(row.translation_ko), translationStatus: text(row.translation_status) as TranslationStatus,
    translationError: nullableText(row.translation_error), translatedAt: nullableText(row.translated_at),
    deeplink: text(row.deeplink), status: text(row.status) as DiscordMessageStatus,
    detectedLanguage: nullableText(row.detected_language), replyState: text(row.reply_state) as DiscordMessageRecord["replyState"],
    createdAt: text(row.created_at), editedAt: nullableText(row.edited_at), deletedAt: nullableText(row.deleted_at),
    receivedAt: text(row.received_at)
  };
}

function mapAttachmentState(row: Record<string, unknown>): SlackAttachmentRelayState {
  return {
    messageId: text(row.message_id),
    attachmentId: text(row.attachment_id),
    sourceRevision: text(row.source_revision),
    status: text(row.status) as SlackAttachmentRelayStatus,
    slackFileId: nullableText(row.slack_file_id),
    lastError: nullableText(row.last_error),
    updatedAt: text(row.updated_at)
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
