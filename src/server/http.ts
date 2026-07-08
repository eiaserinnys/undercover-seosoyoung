import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { createAuthService, type AuthService } from "./auth.js";
import type { AppConfig } from "./config.js";
import { collectorMode, configToSettings } from "./config.js";
import { messageEventId, type AppDatabase } from "./database.js";
import type { MessageEventHub } from "./messageEvents.js";
import type { DiscordMessageStatus, HealthResponse, MeResponse, MessageEventPayload, MessageListResponse } from "../shared/types.js";

export interface ApiContext {
  config: AppConfig;
  db: AppDatabase;
  messageEvents: MessageEventHub;
  staticDir: string;
  auth?: AuthService;
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
  const auth = context.auth ?? createAuthService(context.config);
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      if (url.pathname === "/healthz") {
        sendJson(response, context.config.configErrors.length > 0 ? 503 : 200, buildHealth(context));
        return;
      }
      if (await auth.handleAuthRoute(request, response, url)) {
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/me") {
        handleMe(auth, request, response);
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        if (!auth.currentUser(request)) {
          auth.rejectUnauthenticated(response);
          return;
        }
        await handleApi(context, request, response, url);
        return;
      }
      if (url.pathname.startsWith("/auth/")) {
        sendJson(response, 404, { error: "Not found" });
        return;
      }
      serveStatic(context.staticDir, url.pathname, response);
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Unknown server error" });
    }
  });
}

function handleMe(auth: AuthService, request: IncomingMessage, response: ServerResponse): void {
  const user = auth.currentUser(request);
  if (!user) {
    const payload: MeResponse = { authenticated: false, error: "unauthorized" };
    sendJson(response, 401, payload);
    return;
  }
  const payload: MeResponse = { authenticated: true, user };
  sendJson(response, 200, payload);
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
      total: context.db.messageCount(),
      latestEventId: context.db.latestEventId()
    };
    sendJson(response, 200, payload);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/message-events") {
    handleMessageEvents(context, request, response, url);
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

function handleMessageEvents(context: ApiContext, request: IncomingMessage, response: ServerResponse, url: URL): void {
  response.writeHead(200, {
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no"
  });
  response.write(": connected\n\n");

  const lastEventId = request.headers["last-event-id"]?.toString() ?? url.searchParams.get("lastEventId");
  const unsubscribe = context.messageEvents.subscribe((payload) => {
    writeSseMessage(response, payload);
  });
  const keepAlive = setInterval(() => {
    response.write(": keep-alive\n\n");
  }, 25_000);
  keepAlive.unref?.();
  request.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
  });

  for (const message of context.db.listMessagesAfterEventId(lastEventId, { limit: 200 })) {
    writeSseMessage(response, {
      eventId: messageEventId(message),
      message
    });
  }
}

function writeSseMessage(response: ServerResponse, payload: MessageEventPayload): void {
  response.write(`id: ${payload.eventId}\n`);
  response.write("event: message\n");
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
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
