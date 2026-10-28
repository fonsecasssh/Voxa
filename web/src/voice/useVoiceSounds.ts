// Plays the interface sounds of a call by comparing each voice state with the previous
// one: you joined or left, someone joined or left your channel, you (un)muted or
// (un)deafened, someone started sharing their screen.

import { useEffect, useRef } from "react";
import { playSound } from "../sounds.ts";
import type { VoiceSnapshot } from "./VoiceClient.ts";
import type { VoiceMember } from "./types.ts";

interface Seen {
  status: VoiceSnapshot["status"];
  channelId: string | null;
  muted: boolean;
  deafened: boolean;
  sharing: boolean;
  /** Others in the channel, once the member list for it has arrived. */
  others: Set<string> | null;
  sharers: Set<string>;
}

export function useVoiceSounds(vs: VoiceSnapshot, members: VoiceMember[] | undefined) {
  const prev = useRef<Seen | null>(null);
  const sharing = !!vs.localScreen;

  useEffect(() => {
    const connected = vs.status === "connected";
    const othersList = connected && members ? members.filter((m) => m.socketId !== vs.selfSocketId) : null;
    const now: Seen = {
      status: vs.status,
      channelId: vs.channelId,
      muted: vs.muted,
      deafened: vs.deafened,
      sharing,
      others: othersList ? new Set(othersList.map((m) => m.socketId)) : null,
      sharers: new Set(othersList?.filter((m) => m.screenStreamId).map((m) => m.socketId) ?? []),
    };
    const p = prev.current;
    prev.current = now;
    if (!p) return;

    if (connected && (p.status !== "connected" || p.channelId !== vs.channelId)) {
      playSound("join");
      return;
    }
    if (vs.status === "idle" && p.status !== "idle") {
      playSound("leave");
      return;
    }
    if (!connected || p.status !== "connected") return;

    if (now.deafened !== p.deafened) playSound(now.deafened ? "deafen" : "undeafen");
    else if (now.muted !== p.muted) playSound(now.muted ? "mute" : "unmute");

    if (p.others && now.others) {
      const joined = [...now.others].some((id) => !p.others!.has(id));
      const left = [...p.others].some((id) => !now.others!.has(id));
      if (joined) playSound("userJoin");
      else if (left) playSound("userLeave");
    }
    const someoneStarted = [...now.sharers].some((id) => !p.sharers.has(id));
    if ((now.sharing && !p.sharing) || someoneStarted) playSound("streamStart");
  }, [vs.status, vs.channelId, vs.muted, vs.deafened, vs.selfSocketId, sharing, members]);
}
