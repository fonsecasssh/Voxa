// Renders a message's formatting (see shared/markdown.ts) as elements: never as HTML.

import { useState, type ReactNode } from "react";
import { parseMarkdown, type MdNode } from "../../../shared/markdown.ts";
import { emojiImageUrl } from "../customEmojis.ts";

export interface MentionTarget {
  id: string;
  /** Display name in this place (nickname in a server). */
  label: string;
}

interface Props {
  content: string;
  selfId: string;
  /** Who an @username refers to here, or null when nobody by that name can read it. */
  resolveUsername: (username: string) => MentionTarget | null;
}

/** A server emoji; if it was deleted, its :name: as text. */
export function CustomEmojiImg({ id, name, size }: { id: string; name: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <>:{name}:</>;
  return (
    <img
      className="custom-emoji"
      src={emojiImageUrl(id)}
      alt={`:${name}:`}
      title={`:${name}:`}
      draggable={false}
      style={size ? { width: size, height: size } : undefined}
      onError={() => setBroken(true)}
    />
  );
}

/** Hidden until clicked, like Discord's ||spoiler||. */
function Spoiler({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  return (
    <span
      className={`spoiler ${shown ? "shown" : ""}`}
      role={shown ? undefined : "button"}
      tabIndex={shown ? undefined : 0}
      aria-label={shown ? undefined : "Spoiler: clique para ver"}
      onClick={() => setShown(true)}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setShown(true)}
    >
      <span aria-hidden={!shown}>{children}</span>
    </span>
  );
}

export function Markdown({ content, selfId, resolveUsername }: Props) {
  const render = (nodes: MdNode[]): ReactNode[] =>
    nodes.map((n, i) => {
      switch (n.t) {
        case "text":
          return n.v;
        case "b":
          return <strong key={i}>{render(n.c)}</strong>;
        case "i":
          return <em key={i}>{render(n.c)}</em>;
        case "u":
          return <u key={i}>{render(n.c)}</u>;
        case "s":
          return <s key={i}>{render(n.c)}</s>;
        case "spoiler":
          return <Spoiler key={i}>{render(n.c)}</Spoiler>;
        case "code":
          return (
            <code key={i} className="inline-code">
              {n.v}
            </code>
          );
        case "codeblock":
          return (
            <pre key={i} className="code-block" data-lang={n.lang || undefined}>
              <code>{n.v}</code>
            </pre>
          );
        case "quote":
          return <blockquote key={i}>{render(n.c)}</blockquote>;
        case "link":
          return (
            <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow ugc">
              {n.text}
            </a>
          );
        case "emoji":
          return <CustomEmojiImg key={i} id={n.id} name={n.name} />;
        case "mention": {
          if (n.name === "everyone") {
            return (
              <span key={i} className="mention">
                @everyone
              </span>
            );
          }
          const target = resolveUsername(n.name);
          if (!target) return `@${n.name}`;
          return (
            <span key={i} className={`mention ${target.id === selfId ? "me" : ""}`} title={`@${n.name}`}>
              @{target.label}
            </span>
          );
        }
      }
    });
  return <>{render(parseMarkdown(content))}</>;
}
