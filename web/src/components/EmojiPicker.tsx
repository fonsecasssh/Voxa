// Emoji picker for the message box: every emoji, grouped like on the phone keyboard,
// searchable in Portuguese ("risada", "coração", "kkk"), with the recently used ones
// first. The emoji list (with Portuguese names) loads the first time it is opened, and
// emojis newer than the system's emoji font can draw (e.g. on Windows 10) are left out.

import { useEffect, useMemo, useRef, useState } from "react";

interface Emoji {
  unicode: string;
  label: string;
  group: number;
  /** Label, tags and emoticon, lower case without accents, for searching. */
  search: string;
  /** The label and each tag on its own, normalized, for ranking matches. */
  words: string[];
}

interface DataEmoji {
  emoji: string;
  label: string;
  group?: number;
  order?: number;
  tags?: string[];
  /** Unicode Emoji version that introduced it. */
  version: number;
}

/**
 * Whether this system draws an emoji in color (an emoji font has it) rather than as a
 * monochrome "tofu" box or as separate pieces.
 */
function drawsInColor(emoji: string): boolean {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return true;
    ctx.font = '24px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
    ctx.textBaseline = "top";
    ctx.fillStyle = "#000";
    const width = ctx.measureText(emoji).width;
    ctx.fillText(emoji, 0, 2);
    const px = ctx.getImageData(0, 0, 32, 32).data;
    let colored = false;
    for (let i = 0; i < px.length && !colored; i += 4) colored = px[i + 3] > 0 && (px[i] !== px[i + 1] || px[i + 1] !== px[i + 2]);
    // A sequence the font doesn't join comes out as two or more glyphs side by side.
    return colored && width < 40;
  } catch {
    return true;
  }
}

/** Newest emoji version the system can draw, testing one sample of each version. */
function newestSupportedVersion(all: DataEmoji[]): number {
  const versions = [...new Set(all.map((e) => e.version))].filter((v) => v >= 11).sort((a, b) => a - b);
  let newest = 5;
  for (const v of versions) {
    const sample = all.find((e) => e.version === v);
    if (!sample || !drawsInColor(sample.emoji)) break;
    newest = v;
  }
  return newest;
}

const GROUPS = [
  { id: 0, label: "Carinhas e emoções", icon: "😀" },
  { id: 1, label: "Pessoas", icon: "👋" },
  { id: 3, label: "Animais e natureza", icon: "🐶" },
  { id: 4, label: "Comida e bebida", icon: "🍔" },
  { id: 5, label: "Viagens e lugares", icon: "🚗" },
  { id: 6, label: "Atividades", icon: "⚽" },
  { id: 7, label: "Objetos", icon: "💡" },
  { id: 8, label: "Símbolos", icon: "❤️" },
  { id: 9, label: "Bandeiras", icon: "🏁" },
];

/** Ties in a search go to the emojis people use most. */
const POPULAR = ["😂", "❤️", "🔥", "👍", "😭", "🙏", "😍", "🥰", "😊", "🤣", "💀", "😎", "👀", "✨", "🎉", "😅", "🤔", "😡", "👏", "💜"];

/** Lower is better: exact name, exact keyword, start of a word, anywhere. */
function matchScore(e: Emoji, q: string): number {
  if (e.words[0] === q) return 0;
  if (e.words.includes(q)) return 1;
  if (e.words.some((w) => w.startsWith(q) || w.includes(" " + q))) return 2;
  return 3;
}

const RECENT_KEY = "voxa.emoji.recent";
const MAX_RECENT = 24;

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

let emojis: Promise<Emoji[]> | null = null;
function loadEmojis(): Promise<Emoji[]> {
  emojis ??= import("emojibase-data/pt/data.json").then((m) => {
    const data = m.default as DataEmoji[];
    const newest = newestSupportedVersion(data);
    return (
      data
        // Group 2 holds skin-tone and hair components, not emojis to send.
        .filter((e) => e.group !== undefined && e.group !== 2 && e.version <= newest)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((e) => ({
          unicode: e.emoji,
          label: e.label,
          group: e.group!,
          search: normalize([e.label, ...(e.tags ?? [])].join(" ")),
          words: [e.label, ...(e.tags ?? [])].map(normalize),
        }))
    );
  });
  return emojis;
}

function readRecent(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string").slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

function rememberRecent(unicode: string) {
  try {
    const list = [unicode, ...readRecent().filter((u) => u !== unicode)].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Storage unavailable: no recents this time.
  }
}

interface Props {
  onPick: (emoji: string) => void;
  onClose: () => void;
}

export function EmojiPicker({ onPick, onClose }: Props) {
  const [all, setAll] = useState<Emoji[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [hover, setHover] = useState<Emoji | null>(null);
  const [recent] = useState(readRecent);
  const ref = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadEmojis().then(setAll, () => setFailed(true));
  }, []);

  useEffect(() => {
    const outside = (e: MouseEvent) => {
      const t = e.target as Element;
      if (!ref.current?.contains(t) && !t.closest(".emoji-toggle")) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", outside);
    window.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", outside);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose]);

  const byUnicode = useMemo(() => new Map(all?.map((e) => [e.unicode, e])), [all]);
  const results = useMemo(() => {
    const q = normalize(query.trim());
    if (!all || !q) return null;
    const words = q.split(/\s+/);
    const rank = (e: Emoji) => {
      const r = recent.indexOf(e.unicode);
      const p = POPULAR.indexOf(e.unicode);
      return matchScore(e, q) * 1000 + (r >= 0 ? r : p >= 0 ? 100 + p : 500);
    };
    return all
      .filter((e) => words.every((w) => e.search.includes(w)))
      .map((e, i) => ({ e, score: rank(e) * 10000 + i }))
      .sort((x, y) => x.score - y.score)
      .slice(0, 160)
      .map((x) => x.e);
  }, [all, query, recent]);

  const pick = (e: Emoji, keepOpen: boolean) => {
    rememberRecent(e.unicode);
    onPick(e.unicode);
    // Like Discord: Shift+click picks several without closing.
    if (!keepOpen) onClose();
  };

  const grid = (list: Emoji[]) => (
    <div className="emoji-grid">
      {list.map((e) => (
        <button
          key={e.unicode}
          type="button"
          className="emoji-btn"
          title={e.label}
          aria-label={e.label}
          onMouseEnter={() => setHover(e)}
          onFocus={() => setHover(e)}
          onClick={(ev) => pick(e, ev.shiftKey)}
        >
          {e.unicode}
        </button>
      ))}
    </div>
  );

  const recentEmojis = recent.map((u) => byUnicode.get(u)).filter((e): e is Emoji => !!e);

  return (
    <div className="emoji-picker" ref={ref} role="dialog" aria-label="Emojis">
      <div className="emoji-search">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar emoji (ex.: risada, coração, fogo)"
          aria-label="Buscar emoji"
          onKeyDown={(e) => {
            if (e.key === "Enter" && results?.[0]) {
              e.preventDefault();
              pick(results[0], e.shiftKey);
            }
          }}
        />
      </div>
      {!results && (
        <nav className="emoji-tabs" aria-label="Categorias">
          {GROUPS.map((g) => (
            <button
              key={g.id}
              type="button"
              title={g.label}
              aria-label={g.label}
              onClick={() => scroller.current?.querySelector(`[data-group="${g.id}"]`)?.scrollIntoView({ block: "start" })}
            >
              {g.icon}
            </button>
          ))}
        </nav>
      )}
      <div className="emoji-scroll" ref={scroller}>
        {failed ? (
          <p className="muted small pad">Não foi possível carregar os emojis.</p>
        ) : !all ? (
          <p className="muted small pad">Carregando emojis…</p>
        ) : results ? (
          results.length ? (
            grid(results)
          ) : (
            <p className="muted small pad">Nenhum emoji encontrado para “{query}”.</p>
          )
        ) : (
          <>
            {recentEmojis.length > 0 && (
              <section>
                <div className="emoji-group-label">Usados recentemente</div>
                {grid(recentEmojis)}
              </section>
            )}
            {GROUPS.map((g) => (
              <section key={g.id} data-group={g.id} className="emoji-section">
                <div className="emoji-group-label">{g.label}</div>
                {grid(all.filter((e) => e.group === g.id))}
              </section>
            ))}
          </>
        )}
      </div>
      <div className="emoji-footer">
        {hover ? (
          <>
            <span className="emoji-footer-big">{hover.unicode}</span>
            <span className="ellipsis">{hover.label}</span>
          </>
        ) : (
          <span className="muted small">Shift + clique para escolher vários</span>
        )}
      </div>
    </div>
  );
}
