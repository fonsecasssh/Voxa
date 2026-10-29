// Right-click on someone in a voice channel: their volume for you (0–200%) and
// "Silenciar para mim", like Discord. Saved per user in this browser.

import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from "react";
import { MAX_USER_VOLUME, userVolumes } from "../voice/userVolumes.ts";

interface Target {
  userId: string;
  name: string;
  x: number;
  y: number;
}

export function useUserVolumes() {
  return useSyncExternalStore(userVolumes.subscribe, userVolumes.all);
}

function UserVolumeMenu({ target, onClose }: { target: Target; onClose: () => void }) {
  useUserVolumes();
  const v = userVolumes.get(target.userId);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: target.x, top: target.y });

  useEffect(() => {
    const el = ref.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({ left: Math.max(8, Math.min(target.x, innerWidth - r.width - 8)), top: Math.max(8, Math.min(target.y, innerHeight - r.height - 8)) });
    }
    const outside = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", outside, true);
    window.addEventListener("keydown", esc);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", outside, true);
      window.removeEventListener("keydown", esc);
      window.removeEventListener("blur", onClose);
    };
  }, [target, onClose]);

  const pct = Math.round(v.volume * 100);
  return (
    <div ref={ref} className="user-menu" role="menu" aria-label={`Opções de ${target.name}`} style={pos}>
      <div className="user-menu-title ellipsis">{target.name}</div>
      <label className="user-menu-volume">
        <span>
          Volume do usuário <span className="muted">{pct}%</span>
        </span>
        <input
          type="range"
          min={0}
          max={MAX_USER_VOLUME * 100}
          step={5}
          value={pct}
          aria-label={`Volume de ${target.name}`}
          style={{ ["--fill" as string]: `${(pct / (MAX_USER_VOLUME * 100)) * 100}%` }}
          onChange={(e) => userVolumes.set(target.userId, { volume: Number(e.target.value) / 100 })}
          onDoubleClick={() => userVolumes.set(target.userId, { volume: 1 })}
        />
      </label>
      <label className="user-menu-item">
        <span>Silenciar para mim</span>
        <input type="checkbox" checked={v.muted} onChange={(e) => userVolumes.set(target.userId, { muted: e.target.checked })} />
      </label>
      {v.volume !== 1 && (
        <button type="button" className="user-menu-item link-like" onClick={() => userVolumes.set(target.userId, { volume: 1 })}>
          Voltar para 100%
        </button>
      )}
    </div>
  );
}

/** A context menu for voice members: `open(event, user)` on right-click, and render `menu`. */
export function useUserVolumeMenu() {
  const [target, setTarget] = useState<Target | null>(null);
  const close = useRef(() => setTarget(null)).current;
  const open = (e: ReactMouseEvent, userId: string, name: string) => {
    e.preventDefault();
    setTarget({ userId, name, x: e.clientX, y: e.clientY });
  };
  return { open, menu: target && <UserVolumeMenu target={target} onClose={close} /> };
}
