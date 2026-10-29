// One message in a conversation: the reply it quotes, its author (unless grouped with the
// previous one), its text, files and clip, its reactions, and the hover toolbar
// (react, reply, edit, delete). Editing happens in place.

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ClipAttachment, FileAttachment, Message, ServerDetails } from "../api.ts";
import { memberColor, memberName } from "../members.ts";
import { MessageFiles } from "./Attachments.tsx";
import { Avatar } from "./Avatar.tsx";
import { Icon } from "./Icon.tsx";
import { LinkEmbeds } from "./LinkEmbeds.tsx";
import { GIPHY_MEDIA } from "../features.ts";
import { CustomEmojiImg, Markdown, type MentionTarget } from "./Markdown.tsx";
import { CUSTOM_EMOJI } from "../customEmojis.ts";

/** A reaction's emoji: a character, or a server emoji's picture. */
const reactionFace = (emoji: string) => {
  const m = emoji.match(CUSTOM_EMOJI);
  return m ? <CustomEmojiImg id={m[3]} name={m[2]} size={18} /> : emoji;
};
import { formatDuration, formatSize } from "./ReplayModal.tsx";

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `Hoje às ${time}`;
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === yesterday.toDateString()) return `Ontem às ${time}`;
  return `${d.toLocaleDateString("pt-BR")} ${time}`;
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

/** Message text with its formatting, mentions and links (opened in a new tab, or the browser in the desktop app). */
function MessageText({ content, edited, selfId, resolveUsername }: { content: string; edited: number | null; selfId: string; resolveUsername: (u: string) => MentionTarget | null }) {
  // Only emojis (up to 27, like Discord): shown big.
  const onlyEmojis =
    content.length < 1200 &&
    content.replace(/<a?:[a-zA-Z0-9_]{2,32}:[0-9a-f-]{36}>|\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|[\u200d\ufe0f\s]/gu, "") === "" &&
    (content.match(/<a?:[a-zA-Z0-9_]{2,32}:[0-9a-f-]{36}>|\p{Extended_Pictographic}|\p{Regional_Indicator}/gu)?.length ?? 0) <= 27;
  return (
    <div className={`message-content ${onlyEmojis ? "jumbo" : ""}`}>
      <Markdown content={content} selfId={selfId} resolveUsername={resolveUsername} />
      {edited && (
        <span className="edited" title={`Editada ${formatTime(edited).toLowerCase()}`}>
          {" "}
          (editado)
        </span>
      )}
    </div>
  );
}

function EditBox({ initial, onSave, onCancel }: { initial: string; onSave: (content: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    el?.focus();
    el?.setSelectionRange(initial.length, initial.length);
  }, [initial]);
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const content = value.trim();
      if (content === initial.trim()) onCancel();
      else onSave(content);
    }
  };
  return (
    <div className="edit-box">
      <textarea ref={ref} value={value} maxLength={4000} rows={1} onChange={(e) => setValue(e.target.value)} onKeyDown={onKeyDown} aria-label="Editar mensagem" />
      <span className="muted small">
        Esc para <button className="link" onClick={onCancel}>cancelar</button> · Enter para{" "}
        <button className="link" onClick={() => onSave(value.trim())}>
          salvar
        </button>
      </span>
    </div>
  );
}

export interface MessageItemProps {
  message: Message;
  /** Shown under the previous message without repeating the author. */
  grouped: boolean;
  server?: ServerDetails;
  selfId: string;
  editing: boolean;
  highlighted: boolean;
  canDelete: boolean;
  /** Can pin and unpin (moderators in servers, anyone in a DM). */
  canPin: boolean;
  onPin: (pinned: boolean) => void;
  resolveName: (userId: string) => string;
  resolveUsername: (username: string) => MentionTarget | null;
  onOpenImage: (f: FileAttachment) => void;
  onReply: () => void;
  onStartEdit: () => void;
  onEdit: (content: string) => void;
  onCancelEdit: () => void;
  onDelete: (skipConfirm: boolean) => void;
  onToggleReaction: (emoji: string, add: boolean) => void;
  onPickReaction: (anchor: DOMRect) => void;
  onJumpTo: (messageId: string) => void;
}

export function MessageItem(p: MessageItemProps) {
  const m = p.message;
  const mine = m.author.id === p.selfId;
  const mentionsMe = (m.mentions.includes(p.selfId) || m.mentionsEveryone) && !mine;
  const name = memberName(p.server, m.author);
  const time = new Date(m.createdAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

  const body = p.editing ? (
    <EditBox initial={m.content} onSave={p.onEdit} onCancel={p.onCancelEdit} />
  ) : (
    <>
      {m.content && GIPHY_MEDIA.test(m.content) ? (
        <button type="button" className="gif-embed" aria-label="Abrir GIF" onClick={() => window.open(m.content, "_blank", "noopener")}>
          <img src={m.content} alt="GIF" loading="lazy" />
        </button>
      ) : (
        m.content && <MessageText content={m.content} edited={m.editedAt} selfId={p.selfId} resolveUsername={p.resolveUsername} />
      )}
      {m.embeds?.length > 0 && !(m.content && GIPHY_MEDIA.test(m.content)) && <LinkEmbeds embeds={m.embeds} />}
      {m.files.length > 0 && <MessageFiles files={m.files} onOpenImage={p.onOpenImage} />}
      {m.attachment && <ClipView clip={m.attachment} />}
    </>
  );

  const reactions = m.reactions.length > 0 && (
    <div className="reactions">
      {m.reactions.map((r) => {
        const reacted = r.userIds.includes(p.selfId);
        const names = r.userIds.map(p.resolveName);
        return (
          <button
            key={r.emoji}
            type="button"
            className={`reaction ${reacted ? "mine" : ""}`}
            aria-pressed={reacted}
            title={`${names.slice(0, 5).join(", ")}${names.length > 5 ? ` e mais ${names.length - 5}` : ""} reagiu com ${r.emoji}`}
            onClick={() => p.onToggleReaction(r.emoji, !reacted)}
          >
            <span className="reaction-emoji">{reactionFace(r.emoji)}</span>
            <span>{r.userIds.length}</span>
          </button>
        );
      })}
      <button type="button" className="reaction add" title="Adicionar reação" aria-label="Adicionar reação" onClick={(e) => p.onPickReaction(e.currentTarget.getBoundingClientRect())}>
        <Icon name="smile" size={16} />
      </button>
    </div>
  );

  const toolbar = !p.editing && (
    <div className="message-actions">
      <button className="msg-action" title="Adicionar reação" aria-label="Adicionar reação" onClick={(e) => p.onPickReaction(e.currentTarget.getBoundingClientRect())}>
        <Icon name="smile" size={16} />
      </button>
      <button className="msg-action" title="Responder" aria-label="Responder" onClick={p.onReply}>
        <Icon name="reply" size={16} />
      </button>
      {p.canPin && (
        <button
          className="msg-action"
          title={m.pinnedAt ? "Desafixar" : "Fixar"}
          aria-label={m.pinnedAt ? "Desafixar mensagem" : "Fixar mensagem"}
          onClick={() => p.onPin(!m.pinnedAt)}
        >
          <Icon name="pin" size={16} />
        </button>
      )}
      {mine && (
        <button className="msg-action" title="Editar" aria-label="Editar mensagem" onClick={p.onStartEdit}>
          <Icon name="pencil" size={16} />
        </button>
      )}
      {p.canDelete && (
        <button className="msg-action danger" title="Apagar mensagem (Shift: sem confirmar)" aria-label="Apagar mensagem" onClick={(e) => p.onDelete(e.shiftKey)}>
          <Icon name="trash" size={16} />
        </button>
      )}
    </div>
  );

  const reply = m.replyTo && (
    <button
      type="button"
      className="reply-preview"
      disabled={!m.replyTo.author}
      onClick={() => p.onJumpTo(m.replyTo!.id)}
      title={m.replyTo.author ? "Ir para a mensagem original" : undefined}
    >
      <span className="reply-spine" aria-hidden="true" />
      {m.replyTo.author ? (
        <>
          <Avatar name={memberName(p.server, m.replyTo.author)} id={m.replyTo.author.id} size={16} src={m.replyTo.author.avatar} />
          <strong style={{ color: memberColor(p.server, m.replyTo.author.id) }}>{memberName(p.server, m.replyTo.author)}</strong>
          <span className="ellipsis">{m.replyTo.content || (m.replyTo.hasFiles ? "Clique para ver o anexo" : "")}</span>
          {m.replyTo.hasFiles && <Icon name="file" size={14} />}
        </>
      ) : (
        <span className="muted">A mensagem original foi apagada.</span>
      )}
    </button>
  );

  return (
    <div
      id={`msg-${m.id}`}
      className={`message ${p.grouped ? "grouped" : ""} ${p.highlighted ? "highlight" : ""} ${p.editing ? "editing" : ""} ${mentionsMe ? "mentioned" : ""}`}
    >
      {reply}
      {p.grouped ? (
        <>
          <span className="hover-time">{time}</span>
          <div className="message-body">
            {body}
            {reactions}
          </div>
        </>
      ) : (
        <>
          <Avatar name={name} id={m.author.id} src={m.author.avatar} />
          <div className="message-body">
            <div className="message-meta">
              <strong style={{ color: memberColor(p.server, m.author.id) }}>{name}</strong>
              <span className="muted small">{formatTime(m.createdAt)}</span>
              {m.pinnedAt && (
                <span className="pinned-mark" title="Mensagem fixada">
                  <Icon name="pin" size={12} />
                </span>
              )}
            </div>
            {body}
            {reactions}
          </div>
        </>
      )}
      {toolbar}
    </div>
  );
}
