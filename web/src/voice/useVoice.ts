import { createContext, useContext, useSyncExternalStore } from "react";
import type { VoiceClient, VoiceSnapshot } from "./VoiceClient.ts";

export const VoiceContext = createContext<VoiceClient | null>(null);

const idle = { status: "idle" } as VoiceSnapshot;
const noop = () => () => {};

/** The voice client (null before the socket exists) and its current state. */
export function useVoice(): [VoiceClient | null, VoiceSnapshot] {
  const client = useContext(VoiceContext);
  const snapshot = useSyncExternalStore(client?.subscribe ?? noop, client?.getSnapshot ?? (() => idle));
  return [client, snapshot];
}
