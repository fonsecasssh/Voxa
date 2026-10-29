import { useEffect, useState, type FormEvent } from "react";
import { EmptyState } from "./EmptyState.tsx";
import { ListSkeleton } from "./Skeleton.tsx";
import { api, type Friend, type Presence, type User } from "../api.ts";
import { Avatar, presenceText } from "./Avatar.tsx";
import { PresenceLine } from "./CustomStatus.tsx";
import { MobileNavButton } from "./MobileNav.tsx";
import { useBlocked } from "../blocking.ts";

type Tab = "online" | "all" | "pending" | "blocked" | "add";

interface Props {
  friends: Friend[] | null;
  presence: Record<string, Presence>;
  onOpenDm: (user: User) => void;
}

export function FriendsView({ friends, presence, onOpenDm }: Props) {
  const [tab, setTab] = useState<Tab>("online");
  const [error, setError] = useState<string | null>(null);
  const list = friends ?? [];
  const pending = list.filter((f) => f.state !== "accepted");
  const accepted = list.filter((f) => f.state === "accepted");
  const online = accepted.filter((f) => (presence[f.user.id]?.status ?? "offline") !== "offline");

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const shown = tab === "online" ? online : tab === "all" ? accepted : pending;
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "online", label: "Online" },
    { id: "all", label: "Todos" },
    { id: "pending", label: "Pendentes", count: pending.filter((f) => f.state === "incoming").length },
    { id: "blocked", label: "Bloqueados" },
  ];

  return (
    <main className="main friends-view">
      <header className="chat-header friends-header">
        <MobileNavButton />
        <span className="channel-icon">👥</span>
        <strong>Amigos</strong>
        <span className="divider" />
        {tabs.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
            {!!t.count && <span className="badge">{t.count}</span>}
          </button>
        ))}
        <button className={`tab add ${tab === "add" ? "active" : ""}`} onClick={() => setTab("add")}>
          Adicionar amigo
        </button>
      </header>

      <div className="friends-body">
        {tab === "add" ? (
          <AddFriend />
        ) : tab === "blocked" ? (
          <BlockedList />
        ) : (
          <>
            <div className="group-label">
              {tab === "online" ? "Online" : tab === "all" ? "Todos os amigos" : "Pendentes"} — {shown.length}
            </div>
            {error && <div className="form-error">{error}</div>}
            {friends === null ? (
              <ListSkeleton count={6} avatar={36} twoLines />
            ) : shown.length === 0 ? (
              tab === "pending" ? (
                <EmptyState icon="userPlus" title="Nenhum pedido pendente">
                  Pedidos de amizade que você receber ou enviar aparecem aqui.
                </EmptyState>
              ) : accepted.length === 0 ? (
                <EmptyState
                  icon="users"
                  title="Você ainda não tem amigos aqui"
                  actions={
                    <button className="btn primary" onClick={() => setTab("add")}>
                      Adicionar amigo
                    </button>
                  }
                >
                  Adicione alguém pelo nome de usuário para conversar e ligar direto.
                </EmptyState>
              ) : (
                <EmptyState
                  icon="users"
                  title="Ninguém online agora"
                  actions={
                    <button className="btn subtle" onClick={() => setTab("all")}>
                      Ver todos os amigos
                    </button>
                  }
                >
                  Quando seus amigos entrarem, eles aparecem aqui.
                </EmptyState>
              )
            ) : (
              shown.map((f) => (
                <div key={f.user.id} className="friend-row">
                  <Avatar
                    name={f.user.displayName}
                    id={f.user.id}
                    size={36}
                    status={f.state === "accepted" ? (presence[f.user.id]?.status ?? "offline") : undefined}
                    src={f.user.avatar}
                  />
                  <div className="friend-names">
                    <strong className="ellipsis">
                      {f.user.displayName} <span className="muted small">@{f.user.username}</span>
                    </strong>
                    {f.state === "accepted" && (presence[f.user.id]?.custom || presence[f.user.id]?.activity) ? (
                      <PresenceLine presence={presence[f.user.id]} />
                    ) : (
                      <span className="muted small ellipsis">
                        {f.state === "incoming"
                          ? "Pedido de amizade recebido"
                          : f.state === "outgoing"
                            ? "Pedido de amizade enviado"
                            : presenceText(presence[f.user.id])}
                      </span>
                    )}
                  </div>
                  <div className="friend-actions">
                    {f.state === "accepted" && (
                      <button className="round-icon" title="Enviar mensagem" onClick={() => onOpenDm(f.user)}>
                        💬
                      </button>
                    )}
                    {f.state === "incoming" && (
                      <button className="round-icon ok" title="Aceitar" onClick={() => act(() => api.acceptFriend(f.user.id))}>
                        ✓
                      </button>
                    )}
                    {f.state === "accepted" && (
                      <button
                        className="round-icon"
                        title="Bloquear"
                        aria-label={`Bloquear ${f.user.displayName}`}
                        onClick={() => confirm(`Bloquear ${f.user.displayName}? Vocês deixam de ser amigos e não podem trocar DMs.`) && act(() => api.block(f.user.id))}
                      >
                        ⛔
                      </button>
                    )}
                    <button
                      className="round-icon danger"
                      title={f.state === "accepted" ? "Desfazer amizade" : f.state === "incoming" ? "Recusar" : "Cancelar pedido"}
                      onClick={() => {
                        if (f.state === "accepted" && !confirm(`Desfazer amizade com ${f.user.displayName}?`)) return;
                        act(() => api.removeFriend(f.user.id));
                      }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))
            )}
          </>
        )}
      </div>
    </main>
  );
}

/** People you blocked, with "Desbloquear". */
function BlockedList() {
  const ids = useBlocked();
  const [users, setUsers] = useState<User[] | null>(null);
  useEffect(() => {
    api.blocks().then((r) => setUsers(r.users), () => setUsers([]));
  }, [ids]);
  return (
    <>
      <div className="group-label">Bloqueados — {users?.length ?? 0}</div>
      {users === null ? (
        <ListSkeleton count={3} avatar={36} twoLines />
      ) : users.length === 0 ? (
        <EmptyState icon="lock" title="Ninguém bloqueado">
          Quem você bloquear aparece aqui, para desbloquear quando quiser.
        </EmptyState>
      ) : (
        users.map((u) => (
          <div key={u.id} className="friend-row">
            <Avatar name={u.displayName} id={u.id} size={36} src={u.avatar} />
            <div className="friend-names">
              <strong className="ellipsis">
                {u.displayName} <span className="muted small">@{u.username}</span>
              </strong>
              <span className="muted small">Bloqueado</span>
            </div>
            <div className="friend-actions">
              <button className="btn subtle small" onClick={() => api.unblock(u.id)}>
                Desbloquear
              </button>
            </div>
          </div>
        ))
      )}
    </>
  );
}

function AddFriend() {
  const [username, setUsername] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.addFriend(username.trim());
      setResult({
        ok: true,
        text:
          r.state === "accepted"
            ? `Agora você e ${r.user.displayName} são amigos!`
            : `Pedido enviado para ${r.user.displayName}.`,
      });
      setUsername("");
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="add-friend" onSubmit={submit}>
      <h2>Adicionar amigo</h2>
      <p className="muted">Você pode adicionar amigos pelo nome de usuário deles.</p>
      <div className={`add-friend-row ${result ? (result.ok ? "ok" : "fail") : ""}`}>
        <input
          value={username}
          onChange={(e) => {
            setUsername(e.target.value);
            setResult(null);
          }}
          placeholder="Digite o nome de usuário"
          aria-label="Nome de usuário"
          autoFocus
        />
        <button className="btn primary" disabled={busy || !username.trim()}>
          Enviar pedido
        </button>
      </div>
      {result && <p className={result.ok ? "form-ok" : "form-error"}>{result.text}</p>}
    </form>
  );
}
