import type { AppSettings, MeResponse, MessageEventPayload, MessageListResponse } from "../shared/types.js";

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return (await response.json()) as T;
}

export async function fetchMe(): Promise<MeResponse> {
  const response = await fetch("/api/me");
  if (response.status === 401) return { authenticated: false, error: "unauthorized" };
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return (await response.json()) as MeResponse;
}

export async function fetchSettings(): Promise<AppSettings> {
  return getJson<AppSettings>("/api/settings");
}

export async function fetchMessages(channelId?: string): Promise<MessageListResponse> {
  const params = new URLSearchParams();
  if (channelId) params.set("channelId", channelId);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return getJson<MessageListResponse>(`/api/messages${suffix}`);
}

export function subscribeMessageEvents(lastEventId: string | null, onMessage: (payload: MessageEventPayload) => void): EventSource {
  const params = new URLSearchParams();
  if (lastEventId) params.set("lastEventId", lastEventId);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const source = new EventSource(`/api/message-events${suffix}`);
  source.addEventListener("message", (event) => {
    onMessage(JSON.parse(event.data) as MessageEventPayload);
  });
  return source;
}

export async function logout(): Promise<void> {
  await fetch("/auth/logout", { method: "POST" });
}
