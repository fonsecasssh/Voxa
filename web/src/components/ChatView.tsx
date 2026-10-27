import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Channel, Message, User } from "../api.ts";
import { Avatar } from "./Avatar.tsx";

const GROUP_WINDOW_MS = 5 * 60_000;
const TYPING_THROTTLE_MS = 2500;

interface Props {
  channel: Channel;
  /** The other person, for direct messages. */
  dmUser?: User;
  messages?: Message[];
  hasMore: boolean;
  typingUsers: User[];
  onLoadOlder: () => Promise<void> | undefined;
  onSend: (content: string) => Promise<void>;
  onTyping: () => void;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `Hoje às ${time}`;
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === yesterday.toDateString()) return `Ontem às ${time}`;
  return `${d.toLocaleDateString("pt-BR")} ${time}`;
}

function typingText(users: User[]): string {
  const names = users.map((u) => u.displayName);
  if (names.length === 1) return `${names[0]} está digitando…`;
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} e ${names.at(-1)} estão digitando…`;
  return "Várias pessoas estão digitando…";
}

export function ChatView({ channel, dmUser, messages, hasMore, typingUsers, onLoadOlder, onSend, onTyping }: Props) {
  const title = dmUser ? dmUser.displayName : channel.name;
  const placeholder = dmUser ? `Conversar com @${dmUser.username}` : `Conversar em #${channel.name}`;
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const prevHeight = useRef<number | null>(null);
  const lastTyping = useRef(0);
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);

  // Keep the view pinned to the newest message, unless the user scrolled up to read history.
  // When older messages are prepended, keep the visible ones in place instead.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (prevHeight.current !== null) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
      prevHeight.current = null;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  useLayoutEffect(() => {
    stickToBottom.current = true;
    setDraft("");
    setSendError(null);
  }, [channel.id]);

  const loadOlder = async () => {
    prevHeight.current = listRef.current?.scrollHeight ?? null;
    await onLoadOlder();
  };

  const send = async () => {
    const content = draft.trim();
    if (!content) return;
    setDraft("");
    setSendError(null);
    stickToBottom.current = true;
    try {
      await onSend(content);
    } catch (err) {
      setDraft(content);
      setSendError((err as Error).message);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const onChange = (value: string) => {
    setDraft(value);
    const now = Date.now();
    if (value && now - lastTyping.current > TYPING_THROTTLE_MS) {
      lastTyping.current = now;
      onTyping();
    }
  };

  return (
    <main className="main chat">
      <header className="chat-header">
        {dmUser ? (
          <Avatar name={dmUser.displayName} id={dmUser.id} size={24} />
        ) : (
          <span className="channel-icon">#</span>
        )}
        <strong>{title}</strong>
      </header>

      <div
        className="messages"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {!messages ? (
          <p className="muted center pad">Carregando mensagens…</p>
        ) : (
          <>
            {hasMore ? (
              <button className="btn subtle load-older" onClick={loadOlder}>
                Carregar mensagens antigas
              </button>
            ) : (
              <div className="channel-intro">
                {dmUser ? (
                  <>
                    <Avatar name={dmUser.displayName} id={dmUser.id} size={72} />
                    <h2>{dmUser.displayName}</h2>
                    <p className="muted">
                      Este é o começo do seu histórico de mensagens diretas com <strong>@{dmUser.username}</strong>.
                    </p>
                  </>
                ) : (
                  <>
                    <div className="channel-intro-icon">#</div>
                    <h2>Boas-vindas a #{channel.name}!</h2>
                    <p className="muted">Este é o começo do canal.</p>
                  </>
                )}
              </div>
            )}
            {messages.map((m, i) => {
              const prev = messages[i - 1];
              const grouped = prev && prev.author.id === m.author.id && m.createdAt - prev.createdAt < GROUP_WINDOW_MS;
              return grouped ? (
                <div key={m.id} className="message grouped">
                  <span className="hover-time">
                    {new Date(m.createdAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <div className="message-content">{m.content}</div>
                </div>
              ) : (
                <div key={m.id} className="message">
                  <Avatar name={m.author.displayName} id={m.author.id} />
                  <div>
                    <div className="message-meta">
                      <strong>{m.author.displayName}</strong>
                      <span className="muted small">{formatTime(m.createdAt)}</span>
                    </div>
                    <div className="message-content">{m.content}</div>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>

      <div className="composer">
        {sendError && <div className="form-error">{sendError}</div>}
        <textarea
          rows={1}
          value={draft}
          placeholder={placeholder}
          maxLength={4000}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          autoFocus
        />
        <div className="typing">{typingUsers.length > 0 && typingText(typingUsers)}</div>
      </div>
    </main>
  );
}
