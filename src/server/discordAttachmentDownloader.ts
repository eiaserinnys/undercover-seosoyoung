import type { DiscordAttachmentRecord } from "../shared/types.js";

export interface AttachmentDownloader {
  download(attachment: DiscordAttachmentRecord, maxBytes: number): Promise<Uint8Array>;
}

export class DiscordCdnAttachmentDownloader implements AttachmentDownloader {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30_000
  ) {}

  async download(attachment: DiscordAttachmentRecord, maxBytes: number): Promise<Uint8Array> {
    const url = validateDiscordAttachmentUrl(attachment);
    if (attachment.sizeBytes > maxBytes) {
      throw new Error(`Discord attachment exceeds the ${maxBytes}-byte relay limit`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        redirect: "error",
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`Discord attachment download returned HTTP ${response.status}`);
      }
      const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new Error(`Discord attachment response exceeds the ${maxBytes}-byte relay limit`);
      }
      if (!response.body) throw new Error("Discord attachment response did not include a body");

      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error(`Discord attachment stream exceeds the ${maxBytes}-byte relay limit`);
        }
        chunks.push(value);
      }
      if (attachment.sizeBytes !== total) {
        throw new Error(`Discord attachment size mismatch: expected ${attachment.sizeBytes}, received ${total}`);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function validateDiscordAttachmentUrl(attachment: DiscordAttachmentRecord): URL {
  let url: URL;
  try {
    url = new URL(attachment.sourceUrl);
  } catch {
    throw new Error("Discord attachment URL is invalid");
  }
  if (url.protocol !== "https:" || url.hostname !== "cdn.discordapp.com" || url.port) {
    throw new Error("Discord attachment URL is not an original Discord CDN URL");
  }
  const match = url.pathname.match(/^\/attachments\/(\d+)\/(\d+)\/([^/]+)$/);
  if (!match || match[2] !== attachment.attachmentId) {
    throw new Error("Discord attachment URL path does not match its attachment id");
  }
  let pathFilename: string;
  try {
    pathFilename = decodeURIComponent(match[3]);
  } catch {
    throw new Error("Discord attachment URL filename is invalid");
  }
  if (pathFilename !== attachment.filename) {
    throw new Error("Discord attachment URL path does not match its filename");
  }
  if (!url.searchParams.get("ex") || !url.searchParams.get("is") || !url.searchParams.get("hm")) {
    throw new Error("Discord attachment URL is missing its CDN signature");
  }
  return url;
}
