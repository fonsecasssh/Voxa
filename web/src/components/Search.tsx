// Message search: the box in the header, and the results beside the chat (like Discord).
// Filters: de:usuario, em:canal, tem:arquivo|imagem|video|link|replay.

import { EmptyState } from "./EmptyState.tsx";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, type Message, type ServerDetails } from "../api.ts";
import { memberName } from "../members.ts";
import { Avatar } from "./Avatar.tsx";
import { Icon } from "./Icon.tsx";
import { formatTime } from "./MessageItem.tsx";

export interface SearchScope {
  /** A server id, or a DM channel id. */
  id: string;
  label: string;
}

export function SearchBox({ scope, onSearch }: { scope: SearchScope; onSearch: (q: string) => void }) {
  const [q, setQ] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim()) onSearch(q.trim());
  };
  return (
    <form className="search-box" role="search" onSubmit={submit}>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={`Buscar em ${scope.label}`}
        aria-label={`Buscar em ${scope.label}`}
        maxLength={200}
      />
      <Icon name="search" size={16} />
    </form>
  );
}

const words = (q: string) =>
  q
    .split(/\s+/)
    .filter((t) => !/^(de|em|tem):/.test(t))
    .flatMap((t) => t.split(/[^\p{L}\p{N}]+/u))
    .filter((w) => w.length > 1);

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** The text with the searched words marked (accents ignored, like the search). */
function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const folded = fold(text);
  const marks: [number, number][] = [];
  for (const t of terms.map(fold)) {
    for (let i = folded.indexOf(t); i >= 0; i = folded.indexOf(t, i + t.length)) marks.push([i, i + t.length]);
  }
  marks.sort((a, b) => a[0] - b[0]);
  const out: ReactNode[] = [];
  let at = 0;
  for (const [s, e] of marks) {
    if (s < at) continue;
    out.push(text.slice(at, s), <mark key={s}>{text.slice(s, e)}</mark>);
    at = e;
  }
  out.push(text.slice(at));
  return <>{out}</>;
}

export function SearchPanel({
  scope,
  query,
  server,
  channelName,
  onOpen,
  onClose,
}: {
  scope: SearchScope;
  query: string;
  server?: ServerDetails;
  channelName: (channelId: string) => string | null;
  onOpen: (m: Message) => void;
  onClose: () => void;
}) {
  const [results, setResults] = useState<{ messages: Message[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  useEffect(() => setPage(0), [scope.id, query]);
  useEffect(() => {
    let live = true;
    setResults(null);
    setError(null);
    api.search(scope.id, query, page * 25).then(
      (r) => live && setResults(r),
      (e) => live && setError((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [scope.id, query, page]);

  const terms = words(query);
  const pages = results ? Math.ceil(results.total / 25) : 0;
  return (
    <aside className="members search-panel" aria-label="Resultados da busca">
      <header className="search-head">
        <strong>{results ? `${results.total} ${results.total === 1 ? "resultado" : "resultados"}` : "Buscando…"}</strong>
        <button className="icon-btn" title="Fechar busca" aria-label="Fechar busca" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </header>
      <p className="muted small search-tip">
        Filtros: <code>de:usuario</code> <code>em:canal</code> <code>tem:imagem</code> <code>tem:link</code>
      </p>
      {error && <div className="form-error">{error}</div>}
      {results?.messages.length === 0 && (
        <EmptyState icon="search" title="Nada encontrado" compact>
          Tente outras palavras ou tire algum filtro.
        </EmptyState>
      )}
      <div className="search-results">
        {results?.messages.map((m) => {
          const where = channelName(m.channelId);
          return (
            <button key={m.id} type="button" className="search-result" onClick={() => onOpen(m)}>
              {where && <span className="muted small">#{where}</span>}
              <span className="search-result-head">
                <Avatar name={memberName(server, m.author)} id={m.author.id} size={24} src={m.author.avatar} />
                <strong>{memberName(server, m.author)}</strong>
                <span className="muted small">{formatTime(m.createdAt)}</span>
              </span>
              <span className="search-result-text">
                <Highlighted text={m.content || (m.poll ? `📊 ${m.poll.question}` : m.files.length ? `📎 ${m.files.map((f) => f.name).join(", ")}` : m.attachment ? "🎬 Replay" : "")} terms={terms} />
              </span>
            </button>
          );
        })}
      </div>
      {pages > 1 && (
        <div className="search-pages">
          <button className="btn subtle small" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Anterior
          </button>
          <span className="muted small">
            {page + 1} de {pages}
          </span>
          <button className="btn subtle small" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
            Próxima
          </button>
        </div>
      )}
    </aside>
  );
}
