// Finds web links in a chat message so the web app can make them clickable.
//
// Like Discord: http(s) links and bare "www." addresses become links; punctuation that
// ends a sentence ("veja https://x.com.") is not part of the link, and a closing
// parenthesis only is when the link opened one (Wikipedia-style URLs).

export type MessagePart = { type: "text"; text: string } | { type: "link"; text: string; href: string };

const LINK = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi;
const TRAILING = /[.,;:!?'*_~]+$/;

/** Trims sentence punctuation and unbalanced closing brackets off the end of a candidate link. */
function trimLink(raw: string): string {
  let s = raw;
  for (;;) {
    const before = s;
    s = s.replace(TRAILING, "");
    for (const [open, close] of [["(", ")"], ["[", "]"]]) {
      if (s.endsWith(close) && s.split(close).length > s.split(open).length) s = s.slice(0, -1);
    }
    if (s === before) return s;
  }
}

function toHref(link: string): string | null {
  const href = /^www\./i.test(link) ? `https://${link}` : link;
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname.includes(".") && url.hostname !== "localhost") return null;
    return url.href;
  } catch {
    return null;
  }
}

export function splitLinks(content: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let last = 0;
  const pushText = (text: string) => {
    if (!text) return;
    const prev = parts.at(-1);
    if (prev?.type === "text") prev.text += text;
    else parts.push({ type: "text", text });
  };
  for (const match of content.matchAll(LINK)) {
    const text = trimLink(match[0]);
    const href = text && toHref(text);
    if (!href) continue;
    pushText(content.slice(last, match.index));
    parts.push({ type: "link", text, href });
    last = match.index + text.length;
  }
  pushText(content.slice(last));
  return parts;
}
