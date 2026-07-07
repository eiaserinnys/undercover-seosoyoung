import type { AppSettings, MessageListResponse } from "../shared/types.js";

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return (await response.json()) as T;
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
