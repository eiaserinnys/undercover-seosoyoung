import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "./config.js";
import type { AuthenticatedUser } from "../shared/types.js";

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const OAUTH_STATE_TTL_SECONDS = 10 * 60;
const SLACK_AUTHORIZE_URL = "https://slack.com/openid/connect/authorize";
const SLACK_TOKEN_URL = "https://slack.com/api/openid.connect.token";
const SLACK_USERINFO_URL = "https://slack.com/api/openid.connect.userInfo";

export interface SlackTokenSet {
  accessToken: string;
}

export interface SlackIdentity {
  slackUserId: string;
  slackTeamId: string | null;
  name: string;
  email: string | null;
  avatarUrl: string | null;
}

export interface SlackOAuthClient {
  exchangeCode(code: string, redirectUri: string): Promise<SlackTokenSet>;
  fetchUserInfo(accessToken: string): Promise<SlackIdentity>;
}

export interface AuthService {
  currentUser(request: IncomingMessage): AuthenticatedUser | null;
  handleAuthRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean>;
  rejectUnauthenticated(response: ServerResponse): void;
}

interface OAuthState {
  expiresAt: number;
  state: string;
  next: string;
}

interface SessionClaims {
  expiresAt: number;
  user: AuthenticatedUser;
  nonce: string;
}

export interface CorksheetHandoffClaims {
  expiresAt: number;
  user: AuthenticatedUser;
  nonce: string;
  next: string;
}

export function sealCorksheetHandoffClaimsForTest(claims: CorksheetHandoffClaims, secret: string): string {
  return sealJson<CorksheetHandoffClaims>(claims, secret);
}

export function createAuthService(config: AppConfig, slackClient: SlackOAuthClient = createSlackOAuthClient(config)): AuthService {
  return {
    currentUser(request) {
      return readSession(request, config);
    },

    async handleAuthRoute(request, response, url) {
      if (request.method === "GET" && url.pathname === "/auth/slack") {
        handleSlackStart(config, request, response, url);
        return true;
      }

      if (request.method === "GET" && url.pathname === "/auth/slack/callback") {
        await handleSlackCallback(config, slackClient, request, response, url);
        return true;
      }

      if (request.method === "GET" && url.pathname === "/auth/corksheet/callback") {
        handleCorksheetCallback(config, response, url);
        return true;
      }

      if ((request.method === "POST" || request.method === "GET") && url.pathname === "/auth/logout") {
        response.setHeader("set-cookie", clearCookie(config.slack.sessionCookieName));
        response.writeHead(303, { location: "/login" });
        response.end();
        return true;
      }

      return false;
    },

    rejectUnauthenticated(response) {
      sendJson(response, 401, { authenticated: false, error: "unauthorized" });
    }
  };
}

function handleSlackStart(config: AppConfig, request: IncomingMessage, response: ServerResponse, url: URL): void {
  if (!ensureAuthConfigured(config, response)) return;

  const next = sanitizeNextPath(url.searchParams.get("next") ?? request.headers.referer ?? "/");
  if (config.slack.corksheetSsoStartUrl) {
    const startUrl = new URL(config.slack.corksheetSsoStartUrl);
    startUrl.searchParams.set("next", next);
    response.writeHead(303, { location: startUrl.toString() });
    response.end();
    return;
  }

  const state = randomUUID();
  const sealedState = sealJson<OAuthState>(
    {
      expiresAt: Date.now() + OAUTH_STATE_TTL_SECONDS * 1000,
      state,
      next
    },
    config.slack.sessionSecret
  );

  const slackUrl = new URL(SLACK_AUTHORIZE_URL);
  slackUrl.searchParams.set("response_type", "code");
  slackUrl.searchParams.set("client_id", config.slack.clientId ?? "");
  slackUrl.searchParams.set("redirect_uri", config.slack.redirectUri);
  slackUrl.searchParams.set("scope", "openid email profile");
  slackUrl.searchParams.set("state", state);

  response.writeHead(303, {
    location: slackUrl.toString(),
    "set-cookie": cookie(config.slack.stateCookieName, sealedState, OAUTH_STATE_TTL_SECONDS)
  });
  response.end();
}

function handleCorksheetCallback(config: AppConfig, response: ServerResponse, url: URL): void {
  if (!ensureAuthConfigured(config, response)) return;
  if (!config.slack.corksheetHandoffSecret) {
    sendHtml(response, 503, "Slack login is not configured", "UNDERCOVER_SSO_BRIDGE_SECRET is required.");
    return;
  }

  const token = url.searchParams.get("token");
  const claims = token ? unsealJson<CorksheetHandoffClaims>(token, config.slack.corksheetHandoffSecret) : null;
  if (!claims || !isCorksheetHandoffClaims(claims) || claims.expiresAt <= Date.now()) {
    sendHtml(response, 401, "Slack login failed", "The Corksheet handoff token is invalid or expired.");
    return;
  }

  const authorization = authorizeSlackIdentity(config, claims.user);
  if (!authorization.ok) {
    sendHtml(response, 403, "Slack login denied", authorization.reason);
    return;
  }

  const session = sealJson<SessionClaims>(
    {
      expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
      user: claims.user,
      nonce: randomUUID()
    },
    config.slack.sessionSecret
  );
  response.writeHead(303, {
    location: sanitizeNextPath(claims.next),
    "set-cookie": cookie(config.slack.sessionCookieName, session, SESSION_TTL_SECONDS)
  });
  response.end();
}

async function handleSlackCallback(
  config: AppConfig,
  slackClient: SlackOAuthClient,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<void> {
  if (!ensureAuthConfigured(config, response)) return;

  const slackError = url.searchParams.get("error");
  if (slackError) {
    sendHtml(response, 400, "Slack login failed", `Slack returned ${escapeHtml(slackError)}.`);
    return;
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const stored = readOAuthState(request, config);
  if (!code || !state || !stored || stored.state !== state) {
    sendHtml(response, 400, "Slack login failed", "OAuth state is missing or expired.");
    return;
  }

  try {
    const tokenSet = await slackClient.exchangeCode(code, config.slack.redirectUri);
    const identity = await slackClient.fetchUserInfo(tokenSet.accessToken);
    const authorization = authorizeSlackIdentity(config, identity);
    if (!authorization.ok) {
      response.setHeader("set-cookie", clearCookie(config.slack.stateCookieName));
      sendHtml(response, 403, "Slack login denied", authorization.reason);
      return;
    }

    const session = sealJson<SessionClaims>(
      {
        expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
        user: identity,
        nonce: randomUUID()
      },
      config.slack.sessionSecret
    );
    response.writeHead(303, {
      location: stored.next,
      "set-cookie": [
        cookie(config.slack.sessionCookieName, session, SESSION_TTL_SECONDS),
        clearCookie(config.slack.stateCookieName)
      ]
    });
    response.end();
  } catch (error) {
    sendHtml(response, 502, "Slack login failed", escapeHtml(error instanceof Error ? error.message : "Slack request failed."));
  }
}

function createSlackOAuthClient(config: AppConfig): SlackOAuthClient {
  return {
    async exchangeCode(code, redirectUri) {
      const body = new URLSearchParams({
        client_id: config.slack.clientId ?? "",
        client_secret: config.slack.clientSecret ?? "",
        code,
        redirect_uri: redirectUri
      });
      const response = await fetch(SLACK_TOKEN_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded"
        },
        body
      });
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok || payload.ok !== true || typeof payload.access_token !== "string") {
        throw new Error(`Slack token exchange failed: ${stringValue(payload.error) || response.status}`);
      }
      return { accessToken: payload.access_token };
    },

    async fetchUserInfo(accessToken) {
      const response = await fetch(SLACK_USERINFO_URL, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`
        }
      });
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok || payload.ok !== true) {
        throw new Error(`Slack user info failed: ${stringValue(payload.error) || response.status}`);
      }
      const slackUserId = stringValue(payload["https://slack.com/user_id"]) || stringValue(payload.sub);
      if (!slackUserId) throw new Error("Slack user info did not include a user id");
      return {
        slackUserId,
        slackTeamId: nullableString(payload["https://slack.com/team_id"]),
        name: stringValue(payload.name) || stringValue(payload.email) || slackUserId,
        email: nullableString(payload.email),
        avatarUrl: nullableString(payload.picture)
      };
    }
  };
}

function readSession(request: IncomingMessage, config: AppConfig): AuthenticatedUser | null {
  const sealed = readCookie(request.headers.cookie ?? "", config.slack.sessionCookieName);
  if (!sealed || !config.slack.sessionSecret) return null;
  const claims = unsealJson<SessionClaims>(sealed, config.slack.sessionSecret);
  if (!claims || claims.expiresAt <= Date.now()) return null;
  const user = claims.user;
  if (!user || typeof user.slackUserId !== "string" || typeof user.name !== "string") return null;
  const authorization = authorizeSlackIdentity(config, user);
  return authorization.ok ? user : null;
}

function readOAuthState(request: IncomingMessage, config: AppConfig): OAuthState | null {
  const sealed = readCookie(request.headers.cookie ?? "", config.slack.stateCookieName);
  if (!sealed || !config.slack.sessionSecret) return null;
  const state = unsealJson<OAuthState>(sealed, config.slack.sessionSecret);
  if (!state || state.expiresAt <= Date.now()) return null;
  return typeof state.state === "string" && typeof state.next === "string" ? state : null;
}

function authorizeSlackIdentity(config: AppConfig, identity: Pick<SlackIdentity, "slackUserId" | "slackTeamId">): { ok: true } | { ok: false; reason: string } {
  if (config.slack.teamId && identity.slackTeamId !== config.slack.teamId) {
    return { ok: false, reason: "This Slack workspace is not allowed." };
  }

  if (config.slack.allowedUserIds.length > 0) {
    return config.slack.allowedUserIds.includes(identity.slackUserId)
      ? { ok: true }
      : { ok: false, reason: "This Slack user is not allowed." };
  }

  if (config.slack.allowWorkspace) return { ok: true };
  return { ok: false, reason: "No Slack access policy is configured." };
}

function isCorksheetHandoffClaims(value: unknown): value is CorksheetHandoffClaims {
  if (!value || typeof value !== "object") return false;
  const claims = value as CorksheetHandoffClaims;
  const user = claims.user;
  return (
    typeof claims.expiresAt === "number" &&
    typeof claims.next === "string" &&
    typeof claims.nonce === "string" &&
    Boolean(user) &&
    typeof user.slackUserId === "string" &&
    (typeof user.slackTeamId === "string" || user.slackTeamId === null) &&
    typeof user.name === "string" &&
    (typeof user.email === "string" || user.email === null) &&
    (typeof user.avatarUrl === "string" || user.avatarUrl === null)
  );
}

function ensureAuthConfigured(config: AppConfig, response: ServerResponse): boolean {
  if (config.authConfigErrors.length === 0) return true;
  sendHtml(response, 503, "Slack login is not configured", config.authConfigErrors.map(escapeHtml).join("<br>"));
  return false;
}

function sealJson<T>(payload: T, secret: string | null): string {
  if (!secret) throw new Error("UNDERCOVER_SESSION_SECRET is required");
  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

function unsealJson<T>(sealed: string, secret: string): T | null {
  const [version, ivRaw, tagRaw, encryptedRaw] = sealed.split(".");
  if (version !== "v1" || !ivRaw || !tagRaw || !encryptedRaw) return null;
  try {
    const key = createHash("sha256").update(secret).digest();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedRaw, "base64url")), decipher.final()]);
    return JSON.parse(decrypted.toString("utf8")) as T;
  } catch {
    return null;
  }
}

function cookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

function clearCookie(name: string): string {
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function readCookie(header: string, name: string): string | null {
  for (const segment of header.split(";")) {
    const [rawKey, ...valueParts] = segment.trim().split("=");
    if (rawKey === name) return valueParts.join("=");
  }
  return null;
}

function sanitizeNextPath(value: string): string {
  try {
    const parsed = new URL(value, "http://local");
    const next = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return next.startsWith("/") && !next.startsWith("//") ? next : "/";
  } catch {
    return "/";
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendHtml(response: ServerResponse, status: number, title: string, message: string): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #171717; background: #f6f7f8; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
    main { width: min(420px, calc(100vw - 32px)); border: 1px solid #dedede; border-radius: 8px; background: #fff; padding: 24px; }
    h1 { margin: 0 0 12px; font-size: 22px; letter-spacing: 0; }
    p { margin: 0; color: #4d535b; line-height: 1.5; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p>${message}</p>
  </main>
</body>
</html>`);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
