import { useEffect, useMemo, useState } from "react";
import { fetchMe, fetchMessages, fetchSettings, logout } from "./api.js";
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
        const [nextSettings, nextMessages] = await Promise.all([fetchSettings(), fetchMessages(selectedChannelId || undefined)]);
        if (cancelled) return;
        setSettings(nextSettings);
        setMessageData(nextMessages);
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
  }, [initialMessages, initialSettings, selectedChannelId]);

  const emptyMessages = useMemo<MessageListResponse>(() => ({ messages: [], channels: [], total: 0 }), []);
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
        <section className="login-panel" aria-label="로딩">
          <p className="eyebrow">Discord Ops</p>
          <h1>암행 서소영</h1>
        </section>
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
      user={user}
      onLogout={handleLogout}
      onSelectChannel={setSelectedChannelId}
    />
  );
}
