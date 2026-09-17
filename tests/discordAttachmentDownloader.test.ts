import { describe, expect, it } from "vitest";
import { DiscordCdnAttachmentDownloader } from "../src/server/discordAttachmentDownloader.js";
import type { DiscordAttachmentRecord } from "../src/shared/types.js";

describe("Discord attachment download boundary", () => {
  it("downloads signed original CDN bytes", async () => {
    const downloader = new DiscordCdnAttachmentDownloader(async () => new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { "content-length": "4" }
    }));

    await expect(downloader.download(attachment(), 20 * 1024 * 1024)).resolves.toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("rejects arbitrary URLs before making a request", async () => {
    let requested = false;
    const downloader = new DiscordCdnAttachmentDownloader(async () => {
      requested = true;
      return new Response();
    });

    await expect(downloader.download({ ...attachment(), sourceUrl: "https://example.com/capture.png" }, 100))
      .rejects.toThrow("not an original Discord CDN URL");
    expect(requested).toBe(false);
  });

  it("enforces the configured cap against the actual response stream", async () => {
    const downloader = new DiscordCdnAttachmentDownloader(async () => new Response(new Uint8Array([1, 2, 3, 4, 5]), {
      status: 200
    }));

    await expect(downloader.download(attachment(), 4)).rejects.toThrow("stream exceeds the 4-byte relay limit");
  });
});

function attachment(): DiscordAttachmentRecord {
  return {
    attachmentId: "123456789012345678",
    filename: "capture.png",
    contentType: "image/png",
    description: null,
    sizeBytes: 4,
    sourceUrl: "https://cdn.discordapp.com/attachments/111111111111111111/123456789012345678/capture.png?ex=1&is=2&hm=3"
  };
}
