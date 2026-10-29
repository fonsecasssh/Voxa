// Placeholders shaped like what's loading (messages, people, channels), shimmering softly
// (still for people who asked their system for less motion).

import type { ReactNode } from "react";

/** Varied but stable widths, so the placeholder looks like text rather than a grid. */
const widths = [72, 46, 88, 60, 34, 80, 54, 66];
const w = (i: number, offset = 0) => `${widths[(i + offset) % widths.length]}%`;

export function MessageSkeleton({ count = 7 }: { count?: number }) {
  return (
    <div className="skeleton-messages" aria-busy="true" aria-label="Carregando mensagens">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton-message">
          <span className="sk sk-circle" style={{ width: 40, height: 40 }} />
          <div className="skeleton-lines">
            <span className="sk sk-line" style={{ width: `${18 + (i % 3) * 6}%`, height: 12 }} />
            <span className="sk sk-line" style={{ width: w(i) }} />
            {i % 3 !== 1 && <span className="sk sk-line" style={{ width: w(i, 3) }} />}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Rows of people or conversations: a round picture and a name (and a second line). */
export function ListSkeleton({ count = 6, avatar = 32, twoLines = false }: { count?: number; avatar?: number; twoLines?: boolean }) {
  return (
    <div className="skeleton-list" aria-busy="true" aria-label="Carregando">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton-row">
          <span className="sk sk-circle" style={{ width: avatar, height: avatar }} />
          <div className="skeleton-lines">
            <span className="sk sk-line" style={{ width: w(i, 2) }} />
            {twoLines && <span className="sk sk-line small" style={{ width: w(i, 5) }} />}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A server that hasn't loaded yet: channel list, messages and members. */
export function ServerSkeleton({ footer, members = true }: { footer: ReactNode; members?: boolean }) {
  return (
    <>
      <aside className="sidebar">
        <div className="skeleton-sidebar" aria-busy="true" aria-label="Carregando servidor">
          <span className="sk sk-line" style={{ width: "60%", height: 16, margin: "6px 4px 18px" }} />
          {[40, 0, 1, 2, 40, 3].map((n, i) =>
            n === 40 ? (
              <span key={i} className="sk sk-line small" style={{ width: "42%", margin: "14px 4px 8px" }} />
            ) : (
              <div key={i} className="skeleton-row">
                <span className="sk" style={{ width: 16, height: 16, borderRadius: 4 }} />
                <span className="sk sk-line" style={{ width: w(n, 1) }} />
              </div>
            ),
          )}
        </div>
        {footer}
      </aside>
      <main className="main">
        <div className="chat-header">
          <span className="sk sk-line" style={{ width: 120, height: 14 }} />
        </div>
        <div className="skeleton-main">
          <MessageSkeleton />
        </div>
      </main>
      {members && (
        <aside className="members">
          <span className="sk sk-line small" style={{ width: "40%", margin: "8px 8px 12px" }} />
          <ListSkeleton count={8} />
        </aside>
      )}
    </>
  );
}
