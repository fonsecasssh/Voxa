// The soundboard's built-in sounds: every voice channel and call has them. Each app
// synthesizes them itself (web/src/soundboard.ts), so only their id travels.

export interface BuiltinSound {
  id: string;
  name: string;
  emoji: string;
}

export const DEFAULT_SOUNDS: BuiltinSound[] = [
  { id: "default:buzina", name: "Buzina", emoji: "📯" },
  { id: "default:palmas", name: "Palmas", emoji: "👏" },
  { id: "default:badumtss", name: "Ba dum tss", emoji: "🥁" },
  { id: "default:grilos", name: "Grilos", emoji: "🦗" },
  { id: "default:triste", name: "Trombone triste", emoji: "🎺" },
  { id: "default:tada", name: "Tadá", emoji: "🎉" },
];

/** Shortest time between two sounds from the same person. */
export const SOUNDBOARD_COOLDOWN_MS = 1500;
