// The chat's text formatting (a subset of Discord's markdown), turned into a small tree the
// web app renders as elements — never as HTML, so a message can't inject markup.
//
//   **negrito**  *itálico* _itálico_  __sublinhado__  ~~riscado~~  ||spoiler||
//   `código`  ```bloco de código```  > citação  @usuário  @everyone  links
//
// Links are found first and kept whole, so "_" or "*" inside a URL never become formatting.
// The server uses findMentions() on the same rules (mentions inside code don't count).

import { splitLinks } from "./links.ts";

export type MdNode =
  | { t: "text"; v: string }
  | { t: "b" | "i" | "u" | "s" | "spoiler"; c: MdNode[] }
  | { t: "code"; v: string }
  | { t: "codeblock"; lang: string; v: string }
  | { t: "quote"; c: MdNode[] }
  | { t: "link"; text: string; href: string }
  | { t: "mention"; name: string }
  /** A server's custom emoji: <:name:id> (<a:name:id> animated). */
  | { t: "emoji"; name: string; id: string; animated: boolean };

/** @username (3–32 letters, digits, _ or .) or @everyone, not glued to a word or an e-mail. */
const MENTION = /(^|[^a-zA-Z0-9_.@])@(everyone|[a-zA-Z0-9_.]{3,32})/g;

const CUSTOM = /<(a?):([a-zA-Z0-9_]{2,32}):([0-9a-f-]{36})>/;

// Links are swapped for placeholders (private-use characters) while formatting is parsed.
const L_OPEN = "";
const L_CLOSE = "";

type Rule = { re: RegExp; make: (m: RegExpExecArray, parse: (s: string) => MdNode[]) => MdNode; wordStart?: boolean };
const RULES: Rule[] = [
  { re: /^`([^`\n]+)`/, make: (m) => ({ t: "code", v: m[1] }) },
  { re: /^\|\|([\s\S]+?)\|\|/, make: (m, p) => ({ t: "spoiler", c: p(m[1]) }) },
  { re: /^\*\*([\s\S]+?)\*\*(?!\*)/, make: (m, p) => ({ t: "b", c: p(m[1]) }) },
  { re: /^__([\s\S]+?)__(?!_)/, make: (m, p) => ({ t: "u", c: p(m[1]) }) },
  { re: /^~~([\s\S]+?)~~/, make: (m, p) => ({ t: "s", c: p(m[1]) }) },
  { re: /^\*(?![\s*])([\s\S]*?[^\s*])\*(?!\*)/, make: (m, p) => ({ t: "i", c: p(m[1]) }) },
  { re: /^_(?![\s_])([\s\S]*?[^\s_])_(?![a-zA-Z0-9_])/, make: (m, p) => ({ t: "i", c: p(m[1]) }), wordStart: true },
];

function parseInline(s: string, links: { text: string; href: string }[]): MdNode[] {
  const out: MdNode[] = [];
  let text = "";
  const flush = () => {
    if (!text) return;
    // Restore links and find mentions in plain text.
    const parts = text.split(new RegExp(`${L_OPEN}(\\d+)${L_CLOSE}`));
    parts.forEach((part, i) => {
      if (i % 2 === 1) {
        const l = links[Number(part)];
        out.push({ t: "link", text: l.text, href: l.href });
        return;
      }
      part.split(CUSTOM).forEach((piece, j) => {
        if (j % 4 === 1) out.push({ t: "emoji", animated: piece === "a", name: "", id: "" });
        else if (j % 4 === 2) (out[out.length - 1] as { name: string }).name = piece;
        else if (j % 4 === 3) (out[out.length - 1] as { id: string }).id = piece;
        else {
          let last = 0;
          for (const m of piece.matchAll(MENTION)) {
            const at = m.index + m[1].length;
            if (at > last) out.push({ t: "text", v: piece.slice(last, at) });
            out.push({ t: "mention", name: m[2] });
            last = at + 1 + m[2].length;
          }
          if (last < piece.length) out.push({ t: "text", v: piece.slice(last) });
        }
      });
    });
    text = "";
  };
  const parse = (inner: string) => parseInline(inner, links);

  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if ("`|*_~".includes(ch)) {
      const rest = s.slice(i);
      const prev = s[i - 1];
      const rule = RULES.find((r) => (!r.wordStart || !prev || !/[a-zA-Z0-9_]/.test(prev)) && r.re.test(rest));
      if (rule) {
        const m = rule.re.exec(rest)!;
        flush();
        const node = rule.make(m, parse);
        // Inside code a link is just text.
        if (node.t === "code") node.v = node.v.replace(new RegExp(`${L_OPEN}(\\d+)${L_CLOSE}`, "g"), (_, n) => links[Number(n)].text);
        out.push(node);
        i += m[0].length;
        continue;
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

/** Parses a message into nodes: code blocks, quotes, inline formatting, links, mentions. */
export function parseMarkdown(content: string): MdNode[] {
  const out: MdNode[] = [];
  // Code blocks first: nothing inside them is formatted.
  const blocks = content.split(/```(?:([a-zA-Z0-9+#-]{1,20})\n)?([\s\S]*?)```/);
  for (let b = 0; b < blocks.length; b += 3) {
    out.push(...parseText(blocks[b]));
    if (b + 2 < blocks.length) out.push({ t: "codeblock", lang: blocks[b + 1] ?? "", v: (blocks[b + 2] ?? "").replace(/^\n|\n$/g, "") });
  }
  return out;
}

/** Text outside code blocks: groups of "> " lines become quotes. */
function parseText(text: string): MdNode[] {
  if (!text) return [];
  const out: MdNode[] = [];
  const lines = text.split("\n");
  let plain: string[] = [];
  let quote: string[] = [];
  const emit = (buf: string[], asQuote: boolean) => {
    if (!buf.length) return;
    const joined = buf.join("\n");
    const links: { text: string; href: string }[] = [];
    // Links become placeholders first (see the top of the file).
    const masked = splitLinks(joined)
      .map((p) => (p.type === "link" ? `${L_OPEN}${links.push({ text: p.text, href: p.href }) - 1}${L_CLOSE}` : p.text))
      .join("");
    const nodes = parseInline(masked, links);
    if (asQuote) out.push({ t: "quote", c: nodes });
    else out.push(...nodes);
  };
  lines.forEach((line, i) => {
    const isQuote = /^> /.test(line) || line === ">";
    const last = i === lines.length - 1;
    if (isQuote) {
      if (plain.length) emit([...plain, ""], false);
      plain = [];
      quote.push(line.replace(/^> ?/, ""));
    } else {
      if (quote.length) emit(quote, true);
      quote = [];
      plain.push(line);
    }
    if (last) {
      emit(quote, true);
      emit(plain, false);
    }
  });
  return out;
}

/** Usernames mentioned (lower case, without duplicates) and whether @everyone is used; code doesn't count. */
export function findMentions(content: string): { usernames: string[]; everyone: boolean } {
  const names = new Set<string>();
  let everyone = false;
  const walk = (nodes: MdNode[]) => {
    for (const n of nodes) {
      if (n.t === "mention") {
        if (n.name === "everyone") everyone = true;
        else names.add(n.name.toLowerCase().replace(/\.+$/, ""));
      } else if ("c" in n) walk(n.c);
    }
  };
  walk(parseMarkdown(content));
  return { usernames: [...names], everyone };
}

/**
 * The links that get a preview: outside code and spoilers, no repeats, at most `max`.
 * A message that is only a GIF link (from the GIF picker) shows the GIF instead.
 */
export function previewLinks(content: string, max = 3): string[] {
  const out: string[] = [];
  const walk = (nodes: MdNode[]) => {
    for (const n of nodes) {
      if (n.t === "link" && !out.includes(n.href)) out.push(n.href);
      else if ((n.t === "b" || n.t === "i" || n.t === "u" || n.t === "s" || n.t === "quote") && "c" in n) walk(n.c);
    }
  };
  walk(parseMarkdown(content));
  return out.filter((u) => !/^https:\/\/media\d?\.giphy\.com\//.test(u)).slice(0, max);
}
