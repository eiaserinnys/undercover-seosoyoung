import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@astryxdesign/core/Card";
import { VStack } from "@astryxdesign/core/Stack";
import { Heading, Text } from "@astryxdesign/core/Text";
import { fetchMe, fetchMessages, fetchSettings, logout, subscribeMessageEvents } from "./api.js";
import { Dashboard } from "./components/Dashboard.js";
import { LoginScreen } from "./components/LoginScreen.js";
import type { AppSettings, AuthenticatedUser, MessageListResponse } from "../shared/types.js";

export interface AppProps {
  initialSettings?: AppSettings;
  initialMessages?: MessageListResponse;
}

export function App({ initialSettings, initialMessages }: AppProps) {
  const [settings, setSettings] = useState<AppSettings | null>(initialSettings ?? null);
  const [messageData, setMessageData] = useState<MessageListResponse | null>(initialMessages ?? null);
  const [selectedChannelId, setSelectedChannelId] = useState<string>("");
  const [authChecked, setAuthChecked] = useState(Boolean(initialSettings && initialMessages));
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<"idle" | "connected" | "reconnecting">("idle");
  const selectedChannelIdRef = useRef(selectedChannelId);
  const lastEventIdRef = useRef(initialMessages?.latestEventId ?? null);
  const hasMessageData = messageData !== null;

  useEffect(() => {
    selectedChannelIdRef.current = selectedChannelId;
  }, [selectedChannelId]);

  const refreshMessages = useCallback(async (channelId = selectedChannelIdRef.current) => {
    const nextMessages = await fetchMessages(channelId || undefined);
    lastEventIdRef.current = nextMessages.latestEventId;
    setMessageData(nextMessages);
    setError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const me = await fetchMe();
        if (cancelled) return;
        if (!me.authenticated) {
          setUser(null);
          setSettings(null);
          setMessageData(null);
          setAuthChecked(true);
          setError(null);
          return;
        }
        setUser(me.user);
        setAuthChecked(true);
        const [nextSettings, nextMessages] = await Promise.all([fetchSettings(), fetchMessages(selectedChannelIdRef.current || undefined)]);
        if (cancelled) return;
        setSettings(nextSettings);
        setMessageData(nextMessages);
        lastEventIdRef.current = nextMessages.latestEventId;
        setError(null);
      } catch (nextError) {
        if (!cancelled) {
          setUser(null);
          setAuthChecked(true);
          setError(nextError instanceof Error ? nextError.message : "Failed to load dashboard");
        }
      }
    }
    if (!initialSettings || !initialMessages) void load();
    return () => {
      cancelled = true;
    };
  }, [initialMessages, initialSettings]);

  useEffect(() => {
    if (!authChecked || (!user && !initialSettings)) return;
    void refreshMessages(selectedChannelId).catch((nextError) => {
      setError(nextError instanceof Error ? nextError.message : "Failed to refresh messages");
    });
  }, [authChecked, initialSettings, refreshMessages, selectedChannelId, user]);

  useEffect(() => {
    if (!authChecked || !messageData || !hasMessageData || (!user && !initialSettings) || typeof EventSource === "undefined") return;
    const source = subscribeMessageEvents(lastEventIdRef.current ?? messageData.latestEventId, (payload) => {
      if (lastEventIdRef.current && !isNewerEventId(payload.eventId, lastEventIdRef.current)) return;
      lastEventIdRef.current = payload.eventId;
      void refreshMessages().catch((nextError) => {
        setError(nextError instanceof Error ? nextError.message : "Failed to sync messages");
      });
    });
    source.onopen = () => setStreamState("connected");
    source.onerror = () => setStreamState("reconnecting");
    return () => {
      source.close();
      setStreamState("idle");
    };
  }, [authChecked, hasMessageData, initialSettings, refreshMessages, user]);

  const emptyMessages = useMemo<MessageListResponse>(() => ({ messages: [], channels: [], total: 0, latestEventId: null }), []);
  const loginError = useMemo(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    return params.get("error");
  }, []);

  async function handleLogout() {
    await logout();
    if (typeof window !== "undefined") window.location.assign("/login");
  }

  if (!authChecked) {
    return (
      <main className="login-shell">
        <Card padding={6} className="login-panel" aria-label="로딩">
          <VStack gap={1}>
            <Text type="supporting" weight="bold">
              Discord Ops
            </Text>
            <Heading level={1}>암행 서소영</Heading>
          </VStack>
        </Card>
      </main>
    );
  }

  if (!user && !initialSettings) {
    return <LoginScreen error={error ?? loginError} />;
  }

  return (
    <Dashboard
      settings={settings}
      messageData={messageData ?? emptyMessages}
      selectedChannelId={selectedChannelId}
      error={error}
      streamState={streamState}
      user={user}
      onLogout={handleLogout}
      onSelectChannel={setSelectedChannelId}
    />
  );
}

function isNewerEventId(next: string, current: string): boolean {
  return next > current;
}
