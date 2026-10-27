import { createContext, useContext, useSyncExternalStore } from "react";
import type { VoiceClient, VoiceSnapshot } from "./VoiceClient.ts";

export const VoiceContext = createContext<VoiceClient | null>(null);

const idle = { status: "idle", speaking: [] as string[] } as VoiceSnapshot;
const getIdle = () => idle;
const noop = () => () => {};

/** Current state of a given voice client (idle while there is none). */
export function useVoiceSnapshot(client: VoiceClient | null): VoiceSnapshot {
  return useSyncExternalStore(client?.subscribe ?? noop, client?.getSnapshot ?? getIdle);
}

/** The voice client from context (null before the socket exists) and its current state. */
export function useVoice(): [VoiceClient | null, VoiceSnapshot] {
  const client = useContext(VoiceContext);
  return [client, useVoiceSnapshot(client)];
}
