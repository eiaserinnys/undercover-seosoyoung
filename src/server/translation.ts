import type { AppConfig } from "./config.js";
import type { AppDatabase, MessageChangeResult } from "./database.js";
import type { MessageEventHub } from "./messageEvents.js";

export interface TranslationClient {
  translateToKorean(input: { messageId: string; content: string }): Promise<TranslationResult>;
}

export interface TranslationResult {
  detectedLanguage: string;
  translationKo: string | null;
}

export interface TranslationService {
  start(): void;
  stop(): void;
  enqueue(messageId: string): void;
  handleMessageChange(change: MessageChangeResult): void;
}

type FetchLike = typeof fetch;

const TRANSLATION_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 30_000;

const TRANSLATION_INSTRUCTIONS = [
  "You translate Discord messages to Korean for an internal read-only operations dashboard.",
  "Return only compact JSON with keys detectedLanguage and translationKo.",
  "If the source is already Korean, set detectedLanguage to ko and translationKo to null.",
  "Preserve names, IDs, URLs, markdown, code, emojis, and line breaks. Do not answer the message."
].join(" ");

export class OpenAITranslationClient implements TranslationClient {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = TRANSLATION_TIMEOUT_MS
  ) {}

  async translateToKorean(input: { messageId: string; content: string }): Promise<TranslationResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json"
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          instructions: TRANSLATION_INSTRUCTIONS,
          input: `Message ID: ${input.messageId}\n\n${input.content}`,
          // gpt-5 models are reasoning models: reasoning tokens count against
          // max_output_tokens. Without minimal effort, a longer message spends
          // the whole budget on reasoning and returns status=incomplete with no
          // output text (empty output_text), which the parser rejects. Minimal
          // effort keeps translation fast (~1-2s) and deterministic.
          reasoning: { effort: "minimal" },
          max_output_tokens: 1024,
          store: false
        })
      });
      if (!response.ok) {
        throw new Error(`OpenAI translation request failed: ${response.status}`);
      }
      const payload = (await response.json()) as Record<string, unknown>;
      return parseTranslationOutput(readResponseText(payload));
    } finally {
      clearTimeout(timer);
    }
  }
}

class NoopTranslationService implements TranslationService {
  start(): void {}
  stop(): void {}
  enqueue(): void {}
  handleMessageChange(): void {}
}

class QueuedTranslationService implements TranslationService {
  private readonly pending = new Set<string>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private draining = false;
  private stopped = false;

  constructor(
    private readonly db: AppDatabase,
    private readonly events: MessageEventHub,
    private readonly client: TranslationClient,
    private readonly retryDelayMs = RETRY_DELAY_MS
  ) {}

  start(): void {
    for (const messageId of this.db.listPendingTranslationMessageIds()) {
      this.enqueue(messageId);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
  }

  enqueue(messageId: string): void {
    if (this.stopped) return;
    this.pending.add(messageId);
    queueMicrotask(() => {
      void this.drain();
    });
  }

  handleMessageChange(change: MessageChangeResult): void {
    if (!change.changed || !change.contentChanged) return;
    if (change.message.status === "deleted" || !change.message.contentOriginal.trim()) return;
    this.enqueue(change.message.messageId);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.stopped && this.pending.size > 0) {
        const [messageId] = this.pending;
        this.pending.delete(messageId);
        await this.translateMessage(messageId);
      }
    } finally {
      this.draining = false;
    }
  }

  private async translateMessage(messageId: string): Promise<void> {
    const message = this.db.getMessage(messageId);
    if (!message || message.status === "deleted" || !message.contentOriginal.trim()) return;
    if (message.translationStatus === "translated" || message.translationStatus === "skipped") return;
    if (isLikelyKorean(message.contentOriginal)) {
      this.events.publish(this.db.markTranslationSkipped(messageId, "ko", new Date().toISOString()));
      return;
    }
    try {
      const result = await this.client.translateToKorean({
        messageId,
        content: message.contentOriginal
      });
      const translatedAt = new Date().toISOString();
      if (!result.translationKo) {
        this.events.publish(this.db.markTranslationSkipped(messageId, result.detectedLanguage || "ko", translatedAt));
        return;
      }
      this.events.publish(this.db.saveTranslation(messageId, result.translationKo, result.detectedLanguage || "und", translatedAt));
    } catch (error) {
      const nextError = error instanceof Error ? error.message : "OpenAI translation failed";
      this.events.publish(this.db.markTranslationPending(messageId, nextError, new Date().toISOString()));
      this.scheduleRetry(messageId);
    }
  }

  private scheduleRetry(messageId: string): void {
    if (this.retryTimers.has(messageId) || this.stopped) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(messageId);
      this.enqueue(messageId);
    }, this.retryDelayMs);
    timer.unref?.();
    this.retryTimers.set(messageId, timer);
  }
}

export function createTranslationService(
  config: AppConfig,
  db: AppDatabase,
  events: MessageEventHub,
  client?: TranslationClient
): TranslationService {
  if (client) {
    return new QueuedTranslationService(db, events, client);
  }
  if (!config.openAI.apiKey) {
    return new NoopTranslationService();
  }
  return new QueuedTranslationService(db, events, new OpenAITranslationClient(config.openAI.apiKey, config.openAI.model));
}

export function isLikelyKorean(content: string): boolean {
  const hangulCount = (content.match(/[\uac00-\ud7af]/g) ?? []).length;
  if (hangulCount < 2) return false;
  const letterCount = (content.match(/[\p{L}]/gu) ?? []).length;
  return letterCount > 0 && hangulCount / letterCount >= 0.25;
}

function readResponseText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === "string") return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = Array.isArray((item as { content?: unknown }).content) ? (item as { content: unknown[] }).content : [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") return text;
    }
  }
  throw new Error("OpenAI translation response did not include output text");
}

function parseTranslationOutput(outputText: string): TranslationResult {
  const parsed = JSON.parse(outputText) as Record<string, unknown>;
  const detectedLanguage = typeof parsed.detectedLanguage === "string" ? parsed.detectedLanguage : "und";
  const translationKo = typeof parsed.translationKo === "string" && parsed.translationKo.trim() ? parsed.translationKo : null;
  return { detectedLanguage, translationKo };
}
