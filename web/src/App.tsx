import { useEffect, useState } from "react";
import { api, ApiError, getToken, setToken, type Server, type User, type UserStatus } from "./api.ts";
import { parseRoute, usePath } from "./router.ts";
import { AuthScreen } from "./components/AuthScreen.tsx";
import { InvitePage } from "./components/InvitePage.tsx";
import { Shell } from "./components/Shell.tsx";

type Session = { user: User; servers: Server[]; status: UserStatus };

export function App() {
  const route = parseRoute(usePath());
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(() => getToken() !== null);

  useEffect(() => {
    if (!getToken()) return;
    api
      .me()
      .then(setSession)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) setToken(null);
      })
      .finally(() => setLoading(false));
  }, []);

  const onAuthenticated = async (token: string) => {
    setToken(token);
    setSession(await api.me());
  };

  const logout = async () => {
    await api.logout().catch(() => {});
    setToken(null);
    setSession(null);
  };

  if (loading) return <div className="splash">Carregando…</div>;
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
      initialStatus={session.status}
      servers={session.servers}
      setServers={(update) => setSession((s) => (s ? { ...s, servers: update(s.servers) } : s))}
      serverId={route.serverId}
      channelId={route.channelId}
      onLogout={logout}
    />
  );
}
