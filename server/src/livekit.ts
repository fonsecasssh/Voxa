// Optional media server (SFU): with LiveKit (self-hosted, or LiveKit Cloud's free tier),
// each person sends their audio and video once and the server forwards it, instead of
// to everyone (the mesh). Good for bigger calls. Set LIVEKIT_URL (wss://…),
// LIVEKIT_API_KEY and LIVEKIT_API_SECRET; without them calls use the mesh.
//
// Voxa still decides who may join which channel: it hands out a short-lived token for
// that one room (the channel id), with the socket id as the participant's identity.

import { createHmac } from "node:crypto";

export interface Sfu {
  url: string;
  /** A token for one participant in one room. */
  token(room: string, identity: string, name: string): string;
}

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/** An HS256 JWT in LiveKit's access token format. */
export function liveKitToken(apiKey: string, apiSecret: string, room: string, identity: string, name: string, ttlSeconds = 6 * 3600, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: apiKey,
      sub: identity,
      name,
      nbf: iat,
      iat,
      exp: iat + ttlSeconds,
      video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false },
    }),
  );
  const signature = createHmac("sha256", apiSecret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

export function createLiveKit(env: NodeJS.ProcessEnv): Sfu | null {
  const { LIVEKIT_URL: url, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret } = env;
  if (!url || !key || !secret) return null;
  return { url, token: (room, identity, name) => liveKitToken(key, secret, room, identity, name) };
}
