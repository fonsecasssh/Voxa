import { useEffect, useState } from "react";
import { api, type Server } from "../api.ts";
import { navigate } from "../router.ts";
import { ServerIcon } from "./Avatar.tsx";
import { Wordmark } from "./Logo.tsx";

export function InvitePage({ code, onJoined }: { code: string; onJoined: (server: Server) => void }) {
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.invite>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.invite(code).then(setInfo, (err) => setError((err as Error).message));
  }, [code]);

  const join = async () => {
    setBusy(true);
    try {
      const { server } = await api.joinInvite(code);
      onJoined(server);
      navigate(`/channels/${server.id}`, true);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card center">
        <div className="auth-brand">
          <Wordmark size={28} />
        </div>
        {error ? (
          <>
            <h1>Convite inválido</h1>
            <p className="muted">{error}</p>
            <button className="btn primary" onClick={() => navigate("/channels", true)}>
              Voltar
            </button>
          </>
        ) : !info ? (
          <p className="muted">Carregando convite…</p>
        ) : (
          <>
            {info.server.banner && <div className="invite-banner" style={{ backgroundImage: `url(${info.server.banner})` }} />}
            <p className="muted small">Você foi convidado para entrar em</p>
            <ServerIcon server={info.server} size={64} />
            <h1>{info.server.name}</h1>
            <p className="muted">
              {info.memberCount} {info.memberCount === 1 ? "membro" : "membros"}
            </p>
            <button className="btn primary" onClick={join} disabled={busy}>
              Aceitar convite
            </button>
          </>
        )}
      </div>
    </div>
  );
}
