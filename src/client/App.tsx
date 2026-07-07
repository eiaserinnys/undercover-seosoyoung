import { useEffect, useMemo, useState } from "react";
import { fetchMessages, fetchSettings } from "./api.js";
import { Dashboard } from "./components/Dashboard.js";
import type { AppSettings, MessageListResponse } from "../shared/types.js";

export interface AppProps {
  initialSettings?: AppSettings;
  initialMessages?: MessageListResponse;
}

export function App({ initialSettings, initialMessages }: AppProps) {
  const [settings, setSettings] = useState<AppSettings | null>(initialSettings ?? null);
  const [messageData, setMessageData] = useState<MessageListResponse | null>(initialMessages ?? null);
  const [selectedChannelId, setSelectedChannelId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [nextSettings, nextMessages] = await Promise.all([fetchSettings(), fetchMessages(selectedChannelId || undefined)]);
        if (cancelled) return;
        setSettings(nextSettings);
        setMessageData(nextMessages);
        setError(null);
      } catch (nextError) {
        if (!cancelled) setError(nextError instanceof Error ? nextError.message : "Failed to load dashboard");
      }
    }
    if (!initialSettings || !initialMessages) void load();
    return () => {
      cancelled = true;
    };
  }, [initialMessages, initialSettings, selectedChannelId]);

  const emptyMessages = useMemo<MessageListResponse>(() => ({ messages: [], channels: [], total: 0 }), []);

  return (
    <Dashboard
      settings={settings}
      messageData={messageData ?? emptyMessages}
      selectedChannelId={selectedChannelId}
      error={error}
      onSelectChannel={setSelectedChannelId}
    />
  );
}
