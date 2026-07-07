import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { AppConfig } from "./config.js";
import { collectorMode, configToSettings } from "./config.js";
import type { AppDatabase } from "./database.js";
import type { DiscordMessageStatus, HealthResponse, MessageListResponse } from "../shared/types.js";

export interface ApiContext {
  config: AppConfig;
  db: AppDatabase;
  staticDir: string;
}

type JsonValue = unknown;

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

export function createAppServer(context: ApiContext) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      if (url.pathname === "/healthz") {
        sendJson(response, context.config.configErrors.length > 0 ? 503 : 200, buildHealth(context));
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        await handleApi(context, request, response, url);
        return;
      }
      serveStatic(context.staticDir, url.pathname, response);
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Unknown server error" });
    }
  });
}

async function handleApi(context: ApiContext, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  if (request.method === "GET" && url.pathname === "/api/settings") {
    sendJson(response, 200, configToSettings(context.config));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/messages") {
    const status = parseStatus(url.searchParams.get("status"));
    const channelId = url.searchParams.get("channelId") ?? undefined;
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    const messages = context.db.listMessages({ channelId, status, limit });
    const payload: MessageListResponse = {
      messages,
      channels: context.db.listChannels(),
      total: context.db.messageCount()
    };
    sendJson(response, 200, payload);
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

function buildHealth(context: ApiContext): HealthResponse {
  return {
    status: context.config.configErrors.length > 0 ? "degraded" : "ok",
    service: "undercover-seosoyoung",
    mode: collectorMode(context.config),
    readOnly: true,
    outboundEnabled: false,
    messageCount: context.db.messageCount(),
    configErrors: [...context.config.configErrors]
  };
}

function parseStatus(value: string | null): DiscordMessageStatus | undefined {
  if (value === "active" || value === "edited" || value === "deleted") return value;
  return undefined;
}

function sendJson(response: ServerResponse, status: number, payload: JsonValue): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function serveStatic(staticDir: string, pathname: string, response: ServerResponse): void {
  const normalized = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const candidate = join(staticDir, normalized === "/" ? "index.html" : normalized);
  const path = existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(staticDir, "index.html");
  if (!existsSync(path)) {
    sendJson(response, 404, { error: "Static client build not found. Run pnpm build first." });
    return;
  }
  response.writeHead(200, { "content-type": contentTypes[extname(path)] ?? "application/octet-stream" });
  createReadStream(path)
    .on("error", () => {
      if (!response.headersSent) sendJson(response, 500, { error: "Failed to read static file" });
      else response.end();
    })
    .pipe(response);
}
