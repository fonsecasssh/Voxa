// Pieces of direct messages beyond the chat itself: a conversation's avatar (a person,
// or a group's stacked faces), starting or adding to a group DM, the group's member
// list, the call bar at the top of a DM, and the incoming call card.

import { useEffect, useState, type ReactNode } from "react";
import {
  MAX_GROUP_DM,
  api,
  type DmSummary,
  type Friend,
  type Presence,
  type User,
} from "../api.ts";
import { playSound } from "../sounds.ts";
import type { VoiceMember } from "../voice/types.ts";
import { Avatar } from "./Avatar.tsx";
import { Icon } from "./Icon.tsx";
import { Modal } from "./Modals.tsx";
import { VoiceStage } from "./VoiceView.tsx";

/** A person's avatar for a 1:1 DM; for a group, the first two members overlapping. */
export function DmAvatar({
  dm,
  size,
  presence,
}: {
  dm: DmSummary;
  size: number;
  presence?: Record<string, Presence>;
}) {
  if (!dm.group && dm.user) {
    const p = presence?.[dm.user.id];
    return (
      <Avatar
        name={dm.user.displayName}
        id={dm.user.id}
        size={size}
        src={dm.user.avatar}
        status={presence ? (p?.status ?? "offline") : undefined}
      />
    );
  }
  const [a, b] = dm.members;
  if (!a) {
    return (
      <span
        className="group-avatar empty"
        style={{ width: size, height: size }}
      >
        <Icon name="users" size={Math.round(size * 0.55)} />
      </span>
    );
  }
  const small = Math.round(size * 0.7);
  return (
    <span
      className="group-avatar"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <span className="back">
        <Avatar name={a.displayName} id={a.id} size={small} src={a.avatar} />
      </span>
      {b && (
        <span className="front">
          <Avatar name={b.displayName} id={b.id} size={small} src={b.avatar} />
        </span>
      )}
    </span>
  );
}

/**
 * Pick friends for a new group DM, or to add to one. From a 1:1 DM, the other person
 * starts selected (like Discord, adding someone there starts a new group).
 */
export function GroupDmModal({
  friends,
  dm,
  onClose,
  onDone,
}: {
  friends: Friend[] | null;
  /** The conversation the "add people" button was in, if any. */
  dm?: DmSummary;
  onClose: () => void;
  onDone: (dm: DmSummary) => void;
}) {
  const inGroup = new Set(dm?.group ? dm.members.map((u) => u.id) : []);
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(dm && !dm.group && dm.user ? [dm.user.id] : []),
  );
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accepted = (friends ?? []).filter(
    (f) => f.state === "accepted" && !inGroup.has(f.user.id),
  );
  const q = query.trim().toLowerCase();
  const shown = accepted.filter(
    (f) =>
      !q ||
      f.user.displayName.toLowerCase().includes(q) ||
      f.user.username.toLowerCase().includes(q),
  );
  // You, plus whoever is already there, plus the new picks.
  const room = MAX_GROUP_DM - 1 - inGroup.size;
  const left = room - picked.size;

  const toggle = (id: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else if (next.size < room) next.add(id);
      return next;
    });

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      let result: DmSummary;
      if (dm?.group) {
        let last: DmSummary | null = null;
        for (const id of picked)
          last = (await api.addToGroupDm(dm.channel.id, id)).dm;
        result = last ?? dm;
      } else if (picked.size === 1 && !dm) {
        // One person: that's a normal DM.
        result = (await api.openDm([...picked][0])).dm;
      } else {
        result = (await api.createGroupDm([...picked])).dm;
      }
      onDone(result);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={dm?.group ? "Adicionar ao grupo" : "Selecionar amigos"}
      onClose={onClose}
      className="group-dm-modal"
    >
      <p className="muted small">
        {left > 0
          ? `Você pode adicionar mais ${left} ${left === 1 ? "amigo" : "amigos"}.`
          : "O grupo está cheio."}{" "}
        Um grupo tem até {MAX_GROUP_DM} pessoas.
      </p>
      <input
        className="input"
        placeholder="Digite o nome de um amigo"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
        aria-label="Buscar amigos"
      />
      <ul className="friend-pick">
        {friends === null ? (
          <li className="muted small">Carregando…</li>
        ) : shown.length === 0 ? (
          <li className="muted small">
            {accepted.length === 0
              ? "Nenhum amigo para adicionar."
              : "Ninguém com esse nome."}
          </li>
        ) : (
          shown.map((f) => (
            <li key={f.user.id}>
              <label className={picked.has(f.user.id) ? "picked" : ""}>
                <Avatar
                  name={f.user.displayName}
                  id={f.user.id}
                  size={32}
                  src={f.user.avatar}
                />
                <span className="ellipsis">
                  {f.user.displayName}{" "}
                  <span className="muted small">@{f.user.username}</span>
                </span>
                <input
                  type="checkbox"
                  checked={picked.has(f.user.id)}
                  disabled={!picked.has(f.user.id) && left <= 0}
                  onChange={() => toggle(f.user.id)}
                  aria-label={f.user.displayName}
                />
              </label>
            </li>
          ))
        )}
      </ul>
      {error && <div className="form-error">{error}</div>}
      <div className="modal-actions">
        <button className="btn subtle" onClick={onClose}>
          Cancelar
        </button>
        <button
          className="btn primary"
          disabled={
            busy || picked.size === 0 || (!dm?.group && !!dm && picked.size < 2)
          }
          onClick={submit}
        >
          {dm?.group
            ? "Adicionar"
            : picked.size > 1 || dm
              ? "Criar grupo"
              : "Criar DM"}
        </button>
      </div>
    </Modal>
  );
}

/** The people in a group DM (beside the chat), with remove (owner) and leave. */
export function GroupMembers({
  dm,
  self,
  presence,
  onLeave,
}: {
  dm: DmSummary;
  self: User;
  presence: Record<string, Presence>;
  onLeave: () => void;
}) {
  const ownerId = dm.group!.ownerId;
  const people = [self, ...dm.members];
  const remove = (u: User) => {
    if (confirm(`Remover ${u.displayName} do grupo?`))
      api
        .removeFromGroupDm(dm.channel.id, u.id)
        .catch((e) => alert((e as Error).message));
  };
  return (
    <aside className="members group-members" aria-label="Membros do grupo">
      <div className="group-label">
        <span>Membros — {people.length}</span>
      </div>
      {people.map((u) => (
        <div key={u.id} className="member">
          <Avatar
            name={u.displayName}
            id={u.id}
            size={32}
            src={u.avatar}
            status={
              u.id === self.id
                ? undefined
                : (presence[u.id]?.status ?? "offline")
            }
          />
          <span className="ellipsis">
            {u.displayName}
            {u.id === ownerId && (
              <span className="owner-crown" title="Dono do grupo">
                {" "}
                👑
              </span>
            )}
          </span>
          {ownerId === self.id && u.id !== self.id && (
            <button
              className="icon-btn subtle"
              title={`Remover ${u.displayName}`}
              onClick={() => remove(u)}
            >
              <Icon name="close" size={14} />
            </button>
          )}
        </div>
      ))}
      <button className="btn subtle danger leave-group" onClick={onLeave}>
        Sair do grupo
      </button>
    </aside>
  );
}

/** Above a DM's messages while it has a call: join it, or the call itself. */
export function DmCallBar({
  members,
  inCall,
  onJoin,
}: {
  members: VoiceMember[];
  inCall: boolean;
  onJoin: (video: boolean) => void;
}) {
  if (inCall) {
    return (
      <div className="dm-call">
        <VoiceStage members={members} compact />
      </div>
    );
  }
  if (members.length === 0) return null;
  return (
    <div className="dm-call idle">
      <div className="dm-call-faces">
        {members.slice(0, 4).map((m) => (
          <Avatar
            key={m.socketId}
            name={m.user.displayName}
            id={m.user.id}
            size={48}
            src={m.user.avatar}
          />
        ))}
      </div>
      <p>
        <strong>{members.map((m) => m.user.displayName).join(", ")}</strong>{" "}
        {members.length === 1 ? "está" : "estão"} na chamada
      </p>
      <div className="dm-call-actions">
        <button className="btn primary" onClick={() => onJoin(false)}>
          <Icon name="phone" size={16} /> Entrar na chamada
        </button>
        <button className="btn subtle" onClick={() => onJoin(true)}>
          <Icon name="video" size={16} /> Com vídeo
        </button>
      </div>
    </div>
  );
}

const RING_EVERY_MS = 2600;
/** Stops ringing after this long, like a phone going to voicemail. */
export const RING_FOR_MS = 30_000;

/** "Fulano está te ligando": answer or decline, ringing until then. */
export function IncomingCall({
  from,
  title,
  children,
  onAccept,
  onDecline,
}: {
  from: User;
  title: string;
  children?: ReactNode;
  onAccept: (video: boolean) => void;
  onDecline: () => void;
}) {
  useEffect(() => {
    playSound("ring");
    const t = setInterval(() => playSound("ring"), RING_EVERY_MS);
    return () => clearInterval(t);
  }, []);
  return (
    <div
      className="incoming-call"
      role="alertdialog"
      aria-label={`Chamada de ${from.displayName}`}
    >
      <span className="incoming-ring">
        <Avatar
          name={from.displayName}
          id={from.id}
          size={80}
          src={from.avatar}
        />
      </span>
      <strong>{title}</strong>
      <span className="muted small">{from.displayName} está te ligando…</span>
      {children}
      <div className="incoming-actions">
        <button
          className="round-btn danger"
          title="Recusar"
          aria-label="Recusar"
          onClick={onDecline}
        >
          <Icon name="hangup" size={24} />
        </button>
        <button
          className="round-btn accept"
          title="Aceitar com vídeo"
          aria-label="Aceitar com vídeo"
          onClick={() => onAccept(true)}
        >
          <Icon name="video" size={24} />
        </button>
        <button
          className="round-btn accept"
          title="Aceitar"
          aria-label="Aceitar"
          onClick={() => onAccept(false)}
        >
          <Icon name="phone" size={24} />
        </button>
      </div>
    </div>
  );
}
