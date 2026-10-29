// Custom emojis of the servers you're in (usable anywhere), and how they're written in
// messages: <:name:id>, or <a:name:id> when animated.

import { createContext, useContext } from "react";
import type { CustomEmoji } from "./api.ts";

export interface CustomEmojiSet {
  emojis: CustomEmoji[];
  /** Server names, for grouping in the picker. */
  serverNames: Record<string, string>;
  /** The server being viewed: its emojis come first, and win when names repeat. */
  currentServerId: string | null;
}

export const CustomEmojiContext = createContext<CustomEmojiSet>({ emojis: [], serverNames: {}, currentServerId: null });
export const useCustomEmojis = () => useContext(CustomEmojiContext);

export const emojiToken = (e: Pick<CustomEmoji, "name" | "id" | "animated">) => `<${e.animated ? "a" : ""}:${e.name}:${e.id}>`;

export const CUSTOM_EMOJI = /^<(a?):([a-zA-Z0-9_]{2,32}):([0-9a-f-]{36})>$/;

export const emojiImageUrl = (id: string) => `/api/emojis/${id}/image`;

/** Turns typed :name: into the server emoji with that name (the current server's first). */
export function resolveEmojiNames(text: string, set: CustomEmojiSet): string {
  if (!set.emojis.length) return text;
  const byName = new Map<string, CustomEmoji>();
  for (const e of set.emojis) if (!byName.has(e.name.toLowerCase()) || e.serverId === set.currentServerId) byName.set(e.name.toLowerCase(), e);
  // Not inside code, and not what's already a token (<:name:id>).
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/(^|[^<a-zA-Z0-9_]):([a-zA-Z0-9_]{2,32}):(?![0-9a-f-]{36}>)/g, (m, pre, name) => {
      const e = byName.get(name.toLowerCase());
      return e ? `${pre}${emojiToken(e)}` : m;
    })))
    .join("");
}
