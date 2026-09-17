import type { DiscordAttachmentRecord } from "../shared/types.js";

export function serializeDiscordAttachments(attachments: DiscordAttachmentRecord[]): string {
  return JSON.stringify(attachments);
}

export function parseDiscordAttachments(value: unknown): DiscordAttachmentRecord[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isDiscordAttachmentRecord);
  } catch {
    return [];
  }
}

export function attachmentRevisionSource(attachment: DiscordAttachmentRecord): Record<string, unknown> {
  return {
    attachmentId: attachment.attachmentId,
    filename: attachment.filename,
    contentType: attachment.contentType,
    description: attachment.description,
    sizeBytes: attachment.sizeBytes,
    source: stableSourceUrl(attachment.sourceUrl)
  };
}

function stableSourceUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}

function isDiscordAttachmentRecord(value: unknown): value is DiscordAttachmentRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.attachmentId === "string"
    && typeof candidate.filename === "string"
    && (typeof candidate.contentType === "string" || candidate.contentType === null)
    && (typeof candidate.description === "string" || candidate.description === null)
    && typeof candidate.sizeBytes === "number"
    && Number.isSafeInteger(candidate.sizeBytes)
    && candidate.sizeBytes >= 0
    && typeof candidate.sourceUrl === "string";
}
