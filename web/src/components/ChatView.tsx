import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Channel, ClipAttachment, Message, User, ServerDetails } from "../api.ts";
import { Avatar } from "./Avatar.tsx";
import { EmojiPicker } from "./EmojiPicker.tsx";
import { Icon } from "./Icon.tsx";
import { memberColor, memberName } from "../members.ts";
import { splitLinks } from "../../../shared/links.ts";
import { formatDuration, formatSize } from "./ReplayModal.tsx";

const GROUP_WINDOW_MS = 5 * 60_000;
const TYPING_THROTTLE_MS = 2500;

interface Props {
  channel: Channel;
  /** The server the channel belongs to, for nicknames and role colors (undefined in DMs). */
  server?: ServerDetails;
  /** The other person, for direct messages. */
  dmUser?: User;
  messages?: Message[];
  hasMore: boolean;
  typingUsers: User[];
  onLoadOlder: () => Promise<void> | undefined;
  onSend: (content: string) => Promise<void>;
  onTyping: () => void;
  /** Whether the viewer may delete this message (their own, or as a moderator). */
  canDelete: (m: Message) => boolean;
  onDelete: (m: Message) => Promise<void>;
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

/** Message text with its web links made clickable (opened in a new tab, or the browser in the desktop app), and its clip. */
function MessageContent({ content, attachment }: { content: string; attachment: ClipAttachment | null }) {
  return (
    <>
      {content && <MessageText content={content} />}
      {attachment && <ClipView clip={attachment} />}
    </>
  );
}

/** An instant replay posted in chat: a player sized to the clip, like Discord's video embeds. */
function ClipView({ clip }: { clip: ClipAttachment }) {
  const [broken, setBroken] = useState(false);
  if (!clip.url || broken) {
    return <div className="clip-embed expired">Este clipe expirou para liberar espaço no servidor.</div>;
  }
  return (
    <div className="clip-embed">
      <video src={clip.url} controls preload="metadata" playsInline style={{ aspectRatio: `${clip.width} / ${clip.height}` }} onError={() => setBroken(true)} />
      <div className="clip-embed-meta">
        <span className="clip-badge">REPLAY</span>
        <span>{formatDuration(clip.duration)}</span>
        <span className="muted">· {formatSize(clip.size)}</span>
        <a href={clip.url} download className="clip-download">
          Baixar
        </a>
      </div>
    </div>
  );
}

function MessageText({ content }: { content: string }) {
  return (
    <div className="message-content">
      {splitLinks(content).map((p, i) =>
        p.type === "link" ? (
          <a key={i} href={p.href} target="_blank" rel="noopener noreferrer nofollow ugc">
            {p.text}
          </a>
        ) : (
          p.text
        ),
      )}
    </div>
  );
}

function typingText(users: User[], server?: ServerDetails): string {
  const names = users.map((u) => memberName(server, u));
  if (names.length === 1) return `${names[0]} está digitando…`;
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} e ${names.at(-1)} estão digitando…`;
  return "Várias pessoas estão digitando…";
}

export function ChatView({ channel, server, dmUser, messages, hasMore, typingUsers, onLoadOlder, onSend, onTyping, canDelete, onDelete }: Props) {
  const title = dmUser ? dmUser.displayName : channel.name;
  const placeholder = dmUser ? `Conversar com @${dmUser.username}` : `Conversar em #${channel.name}`;
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const prevHeight = useRef<number | null>(null);
  const lastTyping = useRef(0);
  const [draft, setDraft] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);

  /** Puts an emoji where the cursor is (or replaces the selection), keeping the cursor after it. */
  const insertEmoji = (emoji: string) => {
    const el = textarea.current;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? draft.length;
    const next = draft.slice(0, start) + emoji + draft.slice(end);
    if (next.length > 4000) return;
    setDraft(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  };

  /** Deletes after confirming; Shift+click skips the question, like Discord. */
  const remove = async (m: Message, skipConfirm: boolean) => {
    if (!skipConfirm && !confirm("Apagar esta mensagem? Isso não pode ser desfeito.")) return;
    try {
      await onDelete(m);
    } catch (err) {
      alert((err as Error).message);
    }
  };
  const actions = (m: Message) =>
    canDelete(m) && (
      <div className="message-actions">
        <button className="msg-action danger" title="Apagar mensagem (Shift: sem confirmar)" aria-label="Apagar mensagem" onClick={(e) => remove(m, e.shiftKey)}>
          <Icon name="trash" size={16} />
        </button>
      </div>
    );
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
          <Avatar name={dmUser.displayName} id={dmUser.id} size={24} src={dmUser.avatar} />
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
                    <Avatar name={dmUser.displayName} id={dmUser.id} size={72} src={dmUser.avatar} />
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
                  <MessageContent content={m.content} attachment={m.attachment} />
                  {actions(m)}
                </div>
              ) : (
                <div key={m.id} className="message">
                  <Avatar name={memberName(server, m.author)} id={m.author.id} src={m.author.avatar} />
                  <div>
                    <div className="message-meta">
                      <strong style={{ color: memberColor(server, m.author.id) }}>{memberName(server, m.author)}</strong>
                      <span className="muted small">{formatTime(m.createdAt)}</span>
                    </div>
                    <MessageContent content={m.content} attachment={m.attachment} />
                  </div>
                  {actions(m)}
                </div>
              );
            })}
          </>
        )}
      </div>

      <div className="composer">
        {sendError && <div className="form-error">{sendError}</div>}
        <div className="composer-box">
          <textarea
            ref={textarea}
            rows={1}
            value={draft}
            placeholder={placeholder}
            maxLength={4000}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            autoFocus
          />
          <button
            type="button"
            className={`emoji-toggle ${emojiOpen ? "active" : ""}`}
            title="Emojis"
            aria-label="Emojis"
            aria-expanded={emojiOpen}
            onClick={() => setEmojiOpen((o) => !o)}
          >
            <Icon name="smile" size={22} />
          </button>
          {emojiOpen && <EmojiPicker onPick={insertEmoji} onClose={() => setEmojiOpen(false)} />}
        </div>
        <div className="typing">{typingUsers.length > 0 && typingText(typingUsers, server)}</div>
      </div>
    </main>
  );
}
