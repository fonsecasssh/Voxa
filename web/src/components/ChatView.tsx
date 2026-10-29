import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { MAX_FILES_PER_MESSAGE, dmTitle, type DmSummary, type Channel, type FileAttachment, type Message, type User, type ServerDetails } from "../api.ts";
import { Lightbox, PendingTray, usePendingFiles } from "./Attachments.tsx";
import { Avatar } from "./Avatar.tsx";
import { DmAvatar } from "./DmParts.tsx";
import { EmojiPicker } from "./EmojiPicker.tsx";
import { Icon } from "./Icon.tsx";
import { MobileNavButton } from "./MobileNav.tsx";
import { MessageItem } from "./MessageItem.tsx";
import { memberName } from "../members.ts";

const GROUP_WINDOW_MS = 5 * 60_000;
const TYPING_THROTTLE_MS = 2500;

interface Props {
  channel: Channel;
  /** The server the channel belongs to, for nicknames and role colors (undefined in DMs). */
  server?: ServerDetails;
  /** The conversation, for direct messages (1:1 or group). */
  dm?: DmSummary;
  /** Buttons at the right of the header (calls, add people…). */
  headerActions?: ReactNode;
  /** Shown between the header and the messages (a DM's call). */
  top?: ReactNode;
  /** Makes the title editable (a group DM's name); empty resets it to the people's names. */
  onRename?: (name: string) => Promise<void>;
  messages?: Message[];
  hasMore: boolean;
  typingUsers: User[];
  onLoadOlder: () => Promise<void> | undefined;
  onSend: (content: string, uploads: string[], replyTo: string | null) => Promise<void>;
  onTyping: () => void;
  selfId: string;
  /** A display name for anyone who reacted. */
  resolveName: (userId: string) => string;
  /** Where you had stopped reading: messages after it get a "Novas mensagens" line. */
  lastReadAt?: number;
  /** People you blocked: their messages are folded away. */
  blocked: Set<string>;
  onUnblock: (userId: string) => void;
  /** People who can be @mentioned here (server members, or the DM's two). */
  mentionables: Mentionable[];
  canMentionEveryone: boolean;
  /** Whether the viewer may delete this message (their own, or as a moderator). */
  canDelete: (m: Message) => boolean;
  onDelete: (m: Message) => Promise<void>;
  onEdit: (m: Message, content: string) => Promise<void>;
  onReact: (m: Message, emoji: string, add: boolean) => Promise<void>;
}

export interface Mentionable {
  id: string;
  username: string;
  /** Display name here (nickname in a server). */
  label: string;
  avatar: string | null;
}

/** Where the reaction picker opens: under (or above) the button that opened it. */
function pickerPosition(anchor: DOMRect) {
  const w = 368;
  const h = 420;
  const left = Math.max(8, Math.min(anchor.right - w, window.innerWidth - w - 8));
  const top = anchor.bottom + 6 + h < window.innerHeight ? anchor.bottom + 6 : Math.max(8, anchor.top - h - 6);
  return { position: "fixed" as const, left, top, right: "auto", bottom: "auto" };
}

function typingText(users: User[], server?: ServerDetails): string {
  const names = users.map((u) => memberName(server, u));
  if (names.length === 1) return `${names[0]} está digitando…`;
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} e ${names.at(-1)} estão digitando…`;
  return "Várias pessoas estão digitando…";
}

/** A title that turns into a text box when clicked (Enter saves, Esc cancels). */
function EditableTitle({ value, placeholder, onSave }: { value: string; placeholder: string; onSave: (v: string) => Promise<void> }) {
  const [editing, setEditing] = useState<string | null>(null);
  if (editing === null) {
    return (
      <button type="button" className="editable-title ellipsis" title="Renomear grupo" onClick={() => setEditing(value)}>
        {value || placeholder}
      </button>
    );
  }
  const save = () => {
    const next = editing.trim();
    setEditing(null);
    if (next !== value) onSave(next).catch((e) => alert((e as Error).message));
  };
  return (
    <input
      className="editable-title-input"
      autoFocus
      maxLength={100}
      value={editing}
      placeholder={placeholder}
      aria-label="Nome do grupo"
      onChange={(e) => setEditing(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") save();
        else if (e.key === "Escape") setEditing(null);
      }}
    />
  );
}

export function ChatView(props: Props) {
  const { channel, server, dm, headerActions, top, onRename, lastReadAt, blocked, onUnblock, messages, hasMore, typingUsers, onLoadOlder, onSend, onTyping, canDelete, onDelete, onEdit, onReact, selfId } = props;
  const title = dm ? dmTitle(dm) : channel.name;
  const target = dm ? (dm.group ? title : `@${dm.user?.username ?? title}`) : `#${channel.name}`;
  const placeholder = dm && !dm.group ? `Conversar com ${target}` : `Conversar em ${target}`;
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const prevHeight = useRef<number | null>(null);
  const lastTyping = useRef(0);
  const [draft, setDraft] = useState("");
  const pending = usePendingFiles();
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [lightbox, setLightbox] = useState<FileAttachment | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
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

  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [reactionPicker, setReactionPicker] = useState<{ message: Message; anchor: DOMRect } | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);

  // --- @mention autocomplete ---
  const [caret, setCaret] = useState(0);
  const [mentionSel, setMentionSel] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState<string | null>(null);
  const byUsername = useMemo(() => new Map(props.mentionables.map((x) => [x.username.toLowerCase(), x])), [props.mentionables]);
  const resolveUsername = (name: string) => {
    const x = byUsername.get(name.toLowerCase()) ?? byUsername.get(name.toLowerCase().replace(/\.+$/, ""));
    return x ? { id: x.id, label: x.label } : null;
  };
  const mentionQuery = useMemo(() => {
    const m = /(^|\s)@([a-zA-Z0-9_.]{0,32})$/.exec(draft.slice(0, caret));
    return m ? m[2].toLowerCase() : null;
  }, [draft, caret]);
  const suggestions = useMemo(() => {
    if (mentionQuery === null || mentionDismissed === `${caret}:${mentionQuery}`) return [];
    const people = props.mentionables
      .filter((x) => x.id !== selfId && (x.username.toLowerCase().startsWith(mentionQuery) || x.label.toLowerCase().includes(mentionQuery)))
      .slice(0, 8);
    const everyone = props.canMentionEveryone && "everyone".startsWith(mentionQuery) ? [{ id: "everyone", username: "everyone", label: "Notificar todo mundo aqui", avatar: null }] : [];
    return [...everyone, ...people];
  }, [mentionQuery, mentionDismissed, caret, props.mentionables, props.canMentionEveryone, selfId]);
  const pickMention = (username: string) => {
    const before = draft.slice(0, caret).replace(/@[a-zA-Z0-9_.]{0,32}$/, `@${username} `);
    const next = before + draft.slice(caret);
    setDraft(next);
    setMentionSel(0);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(before.length, before.length);
      setCaret(before.length);
    });
  };

  /** Runs an action, showing its error (rare: e.g. the message was deleted meanwhile). */
  const attempt = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      alert((err as Error).message);
    }
  };

  /** Deletes after confirming; Shift+click skips the question, like Discord. */
  const remove = (m: Message, skipConfirm: boolean) => {
    if (!skipConfirm && !confirm("Apagar esta mensagem? Isso não pode ser desfeito.")) return;
    attempt(() => onDelete(m));
  };

  const startReply = (m: Message) => {
    setReplyingTo(m);
    setEditingId(null);
    textarea.current?.focus();
  };

  /** Scrolls to a message (e.g. the one a reply quotes) and flashes it. */
  const jumpTo = (id: string) => {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    setHighlight(id);
    setTimeout(() => setHighlight((h) => (h === id ? null : h)), 1600);
  };
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

  // The "Novas mensagens" line: where you were when you opened the channel (it stays put while you read).
  const [dividerAt, setDividerAt] = useState<number | null>(null);
  const dividerFor = useRef<string | null>(null);
  const [dividerAbove, setDividerAbove] = useState(false);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  useLayoutEffect(() => {
    if (dividerFor.current === channel.id || !messages || lastReadAt === undefined) return;
    dividerFor.current = channel.id;
    setDividerAt(messages.some((m) => m.createdAt > lastReadAt && m.author.id !== selfId) ? lastReadAt : null);
  }, [channel.id, messages, lastReadAt, selfId]);
  const checkDivider = () => {
    const el = listRef.current;
    const line = el?.querySelector<HTMLElement>(".new-divider");
    setDividerAbove(!!el && !!line && line.getBoundingClientRect().top < el.getBoundingClientRect().top + 8);
  };
  useLayoutEffect(checkDivider, [messages, dividerAt]);

  useLayoutEffect(() => {
    stickToBottom.current = true;
    dividerFor.current = null;
    setDividerAt(null);
    setRevealed(new Set());
    setDraft("");
    setSendError(null);
    setReplyingTo(null);
    setEditingId(null);
    pending.discard();
  }, [channel.id]);

  const loadOlder = async () => {
    prevHeight.current = listRef.current?.scrollHeight ?? null;
    await onLoadOlder();
  };

  // Messages go out one after another, in the order they were written, without waiting for
  // the previous one to finish (only a message with files waits for its uploads).
  const queue = useRef(Promise.resolve());
  const send = () => {
    const content = draft.trim();
    const withFiles = pending.items.length > 0;
    if ((!content && !withFiles) || (withFiles && sending)) return;
    const replyTo = replyingTo?.id ?? null;
    setDraft("");
    setSendError(null);
    setReplyingTo(null);
    setDividerAt(null);
    stickToBottom.current = true;
    // Files upload in the background as soon as they're picked; this waits for any still going.
    const uploads = withFiles ? pending.ready() : Promise.resolve([]);
    if (withFiles) setSending(true);
    queue.current = queue.current.then(async () => {
      try {
        await onSend(content, await uploads, replyTo);
        if (withFiles) pending.clear();
      } catch (err) {
        setDraft((d) => d || content);
        setSendError((err as Error).message);
      } finally {
        if (withFiles) setSending(false);
      }
    });
  };

  const addFiles = (files: File[]) => {
    if (files.length === 0) return;
    setSendError(pending.add(files));
    textarea.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length > 0) {
      const sel = Math.min(mentionSel, suggestions.length - 1);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setMentionSel((sel + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        pickMention(suggestions[sel].username);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionDismissed(`${caret}:${mentionQuery}`);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === "Escape" && replyingTo) {
      setReplyingTo(null);
    } else if (e.key === "ArrowUp" && !draft && messages) {
      // Like Discord: ↑ in an empty box edits your last message.
      const last = [...messages].reverse().find((m) => m.author.id === selfId && (m.content || m.files.length === 0));
      if (last) {
        e.preventDefault();
        setEditingId(last.id);
      }
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
    <main
      className="main chat"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        addFiles([...e.dataTransfer.files]);
      }}
    >
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div>
            <Icon name="file" size={40} />
            <strong>Solte para enviar em {target}</strong>
            <span className="muted small">Até {MAX_FILES_PER_MESSAGE} arquivos de 25 MB</span>
          </div>
        </div>
      )}
      {lightbox && <Lightbox file={lightbox} onClose={() => setLightbox(null)} />}
      {reactionPicker && (
        <EmojiPicker
          style={pickerPosition(reactionPicker.anchor)}
          ignore=".msg-action, .reaction.add"
          onPick={(emoji) => {
            const m = reactionPicker.message;
            if (!m.reactions.some((r) => r.emoji === emoji && r.userIds.includes(selfId))) attempt(() => onReact(m, emoji, true));
          }}
          onClose={() => setReactionPicker(null)}
        />
      )}
      <header className="chat-header">
        <MobileNavButton />
        {dm ? <DmAvatar dm={dm} size={24} /> : <span className="channel-icon">#</span>}
        {onRename ? <EditableTitle value={dm?.group?.name ?? ""} placeholder={title} onSave={onRename} /> : <strong className="ellipsis">{title}</strong>}
        {headerActions && <div className="chat-header-actions">{headerActions}</div>}
      </header>
      {top}

      <div
        className="messages"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (dividerAt !== null) checkDivider();
        }}
      >
        {dividerAt !== null && dividerAbove && messages && (
          <div className="new-bar" role="status">
            <span>
              {(() => {
                const n = messages.filter((m) => m.createdAt > dividerAt && m.author.id !== selfId).length;
                return `${n >= 50 ? "50+" : n} ${n === 1 ? "nova mensagem" : "novas mensagens"} desde ${new Date(dividerAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
              })()}
            </span>
            <button type="button" onClick={() => listRef.current?.querySelector(".new-divider")?.scrollIntoView({ block: "center", behavior: "smooth" })}>
              Pular
            </button>
            <button type="button" onClick={() => setDividerAt(null)}>
              Marcar como lida
            </button>
          </div>
        )}
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
                {dm ? (
                  <>
                    <DmAvatar dm={dm} size={72} />
                    <h2>{title}</h2>
                    <p className="muted">
                      {dm.group ? (
                        <>
                          Boas-vindas ao começo do grupo <strong>{title}</strong>.
                        </>
                      ) : (
                        <>
                          Este é o começo do seu histórico de mensagens diretas com <strong>{target}</strong>.
                        </>
                      )}
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
              const isNew = dividerAt !== null && m.createdAt > dividerAt && m.author.id !== selfId;
              const firstNew = isNew && !messages.slice(0, i).some((x) => x.createdAt > dividerAt! && x.author.id !== selfId);
              const divider = firstNew && (
                <div className="new-divider" key={`new-${m.id}`}>
                  <span>Novas mensagens</span>
                </div>
              );
              // Messages from someone you blocked fold into one line per run.
              const hidden = (x?: Message) => !!x && blocked.has(x.author.id) && !revealed.has(x.id);
              if (hidden(m)) {
                if (hidden(prev) && !firstNew) return null;
                const run: string[] = [];
                for (let j = i; j < messages.length && hidden(messages[j]); j++) run.push(messages[j].id);
                return [
                  divider,
                  <div key={m.id} className="blocked-message">
                    {run.length === 1 ? "1 mensagem bloqueada" : `${run.length} mensagens bloqueadas`} ·{" "}
                    <button className="link" onClick={() => setRevealed((r) => new Set([...r, ...run]))}>
                      Mostrar
                    </button>
                  </div>,
                ];
              }
              // Replies always show who's talking, like Discord.
              const grouped = !firstNew && !!prev && !m.replyTo && prev.author.id === m.author.id && m.createdAt - prev.createdAt < GROUP_WINDOW_MS;
              return [
                divider,
                <MessageItem
                  key={m.id}
                  message={m}
                  grouped={grouped}
                  server={server}
                  selfId={selfId}
                  editing={editingId === m.id}
                  highlighted={highlight === m.id || replyingTo?.id === m.id}
                  canDelete={canDelete(m)}
                  resolveName={props.resolveName}
                  resolveUsername={resolveUsername}
                  onOpenImage={setLightbox}
                  onReply={() => startReply(m)}
                  onStartEdit={() => setEditingId(m.id)}
                  onCancelEdit={() => {
                    setEditingId(null);
                    textarea.current?.focus();
                  }}
                  onEdit={(content) => {
                    setEditingId(null);
                    textarea.current?.focus();
                    // Emptying a text-only message means deleting it, like Discord asks.
                    if (!content && m.files.length === 0 && !m.attachment) return remove(m, false);
                    attempt(() => onEdit(m, content));
                  }}
                  onDelete={(skip) => remove(m, skip)}
                  onToggleReaction={(emoji, add) => attempt(() => onReact(m, emoji, add))}
                  onPickReaction={(anchor) => setReactionPicker({ message: m, anchor })}
                  onJumpTo={jumpTo}
                />,
              ];
            })}
          </>
        )}
      </div>

      {dm && !dm.group && dm.user && blocked.has(dm.user.id) ? (
        <div className="composer blocked-composer">
          Você bloqueou <strong>@{dm.user.username}</strong>. Vocês não podem trocar mensagens.{" "}
          <button className="link" onClick={() => onUnblock(dm.user!.id)}>
            Desbloquear
          </button>
        </div>
      ) : (
      <div className="composer">
        {sendError && <div className="form-error">{sendError}</div>}
        {replyingTo && (
          <div className="reply-bar">
            <span className="ellipsis">
              Respondendo a <strong>{memberName(server, replyingTo.author)}</strong>
            </span>
            <button type="button" className="reply-bar-close" title="Cancelar resposta (Esc)" aria-label="Cancelar resposta" onClick={() => setReplyingTo(null)}>
              <Icon name="close" size={14} />
            </button>
          </div>
        )}
        <PendingTray items={pending.items} onRemove={pending.remove} />
        <div className="composer-box">
          {suggestions.length > 0 && (
            <div className="mention-popup" role="listbox" aria-label="Mencionar">
              <div className="mention-popup-title">Membros</div>
              {suggestions.map((x, i) => (
                <button
                  key={x.id}
                  type="button"
                  role="option"
                  aria-selected={i === Math.min(mentionSel, suggestions.length - 1)}
                  className={`mention-option ${i === Math.min(mentionSel, suggestions.length - 1) ? "active" : ""}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setMentionSel(i)}
                  onClick={() => pickMention(x.username)}
                >
                  {x.id === "everyone" ? <span className="mention-everyone">@</span> : <Avatar name={x.label} id={x.id} size={24} src={x.avatar} />}
                  <strong className="ellipsis">{x.id === "everyone" ? "@everyone" : x.label}</strong>
                  <span className="muted small ellipsis">{x.id === "everyone" ? x.label : `@${x.username}`}</span>
                </button>
              ))}
            </div>
          )}
          <button type="button" className="attach-btn" title="Enviar arquivo" aria-label="Enviar arquivo" onClick={() => fileInput.current?.click()}>
            <Icon name="plus" size={18} />
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            aria-label="Escolher arquivos"
            onChange={(e) => {
              addFiles([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          <textarea
            ref={textarea}
            rows={1}
            value={draft}
            placeholder={placeholder}
            maxLength={4000}
            onChange={(e) => {
              onChange(e.target.value);
              setCaret(e.target.selectionStart);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              // A screenshot (or any copied file) pasted with Ctrl+V becomes an attachment.
              const files = [...e.clipboardData.files];
              if (files.length === 0) return;
              if (!e.clipboardData.getData("text/plain")) e.preventDefault();
              addFiles(files);
            }}
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
          {emojiOpen && (
            <EmojiPicker
              onPick={insertEmoji}
              onClose={() => setEmojiOpen(false)}
              // A GIF is sent right away, as a message with just its link (shown as the GIF).
              onPickGif={(g) => {
                stickToBottom.current = true;
                attempt(() => onSend(g.url, [], replyingTo?.id ?? null).then(() => setReplyingTo(null)));
              }}
            />
          )}
        </div>
        <div className="typing">{typingUsers.length > 0 && typingText(typingUsers, server)}</div>
      </div>
      )}
    </main>
  );
}
