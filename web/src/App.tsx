import { useCallback, useEffect, useState } from "react";
import { api, ApiError, getToken, setToken, type Activity, type Server, type User, type UserStatus } from "./api.ts";
import { parseRoute, usePath } from "./router.ts";
import { AuthScreen } from "./components/AuthScreen.tsx";
import { InvitePage } from "./components/InvitePage.tsx";
import { ResetPasswordPage, VerifyEmailPage } from "./components/AccountPages.tsx";
import { Shell } from "./components/Shell.tsx";
import { setFeatures } from "./features.ts";
import { disablePush } from "./push.ts";

type Session = Awaited<ReturnType<typeof api.me>>;

export function App() {
  const route = parseRoute(usePath());
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(() => getToken() !== null);

  useEffect(() => {
    if (!getToken()) return;
    api
      .me()
      .then((me) => {
        setFeatures(me.features);
        setSession(me);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) setToken(null);
      })
      .finally(() => setLoading(false));
  }, []);

  const onAuthenticated = async (token: string) => {
    setToken(token);
    const me = await api.me();
    setFeatures(me.features);
    setSession(me);
  };

  const setUser = useCallback((user: User) => setSession((s) => (s ? { ...s, user } : s)), []);
  const setServers = useCallback(
    (update: (s: Server[]) => Server[]) => setSession((s) => (s ? { ...s, servers: update(s.servers) } : s)),
    [],
  );

  const logout = async () => {
    // This device stops getting the account's notifications.
    await disablePush().catch(() => {});
    await api.logout().catch(() => {});
    setToken(null);
    setSession(null);
  };

  if (loading) return <div className="splash">Carregando…</div>;
  // Links from e-mails work signed in or not.
  if (route.name === "reset") return <ResetPasswordPage token={route.token} onAuthenticated={onAuthenticated} />;
  if (route.name === "verifyEmail") return <VerifyEmailPage token={route.token} signedIn={!!session} />;
  if (!session) return <AuthScreen onAuthenticated={onAuthenticated} />;

  if (route.name === "invite") {
    return (
      <InvitePage
        code={route.code}
        onJoined={(server: Server) =>
          setSession((s) => (s && !s.servers.some((x) => x.id === server.id) ? { ...s, servers: [...s.servers, server] } : s))
        }
      />
    );
  }

  return (
    <Shell
      user={session.user}
      setUser={setUser}
      initialStatus={session.status}
      initialActivity={session.activity}
      initialUnread={session.unread}
      initialNotify={session.notify}
      initialBlocked={session.blocked}
      servers={session.servers}
      setServers={setServers}
      serverId={route.serverId}
      channelId={route.channelId}
      onLogout={logout}
    />
  );
}
