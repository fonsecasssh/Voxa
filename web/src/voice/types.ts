import type { User } from "../api.ts";

export interface VoiceMember {
  socketId: string;
  user: User;
  muted: boolean;
  deafened: boolean;
  screenStreamId: string | null;
}
