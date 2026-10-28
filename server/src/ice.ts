// ICE servers for WebRTC.
//
// STUN lets peers discover their public address; that's enough for most home
// networks. TURN relays the media when a direct connection is impossible
// (mobile carriers, corporate networks, strict NATs) — without it, some calls
// would connect but carry no audio.
//
// TURN sources, in order of preference:
//   1. Cloudflare Realtime TURN: short-lived credentials generated here with an
//      API token that never leaves the server (CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_API_TOKEN).
//   2. A static TURN server, e.g. your own coturn (TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL).

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

const DEFAULT_STUN = "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302";
const CREDENTIAL_TTL_S = 24 * 60 * 60;
// Hand out credentials with plenty of life left: a call that starts must not lose its relay mid-way.
const REFRESH_BEFORE_EXPIRY_MS = 6 * 60 * 60 * 1000;

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;

/** Browsers refuse TURN on port 53 (it's DNS) and log an error for each such URL. */
const usableUrl = (u: string) => !/:53(\?|$)/.test(u);

function normalize(raw: unknown): IceServer[] {
  // The API has returned both { iceServers: [...] } and { iceServers: {...} }; accept either.
  const list = (raw as { iceServers?: unknown })?.iceServers;
  const entries = Array.isArray(list) ? list : list ? [list] : [];
  const out: IceServer[] = [];
  for (const e of entries as IceServer[]) {
    const urls = (Array.isArray(e?.urls) ? e.urls : [e?.urls]).filter((u): u is string => typeof u === "string" && usableUrl(u));
    if (urls.length) out.push({ urls, ...(e.username ? { username: e.username, credential: e.credential } : {}) });
  }
  return out;
}

export function createIceProvider(env: Env = process.env, fetchImpl: Fetch = fetch, now = () => Date.now()) {
  const stun: IceServer = { urls: (env.STUN_URLS || DEFAULT_STUN).split(",").map((s) => s.trim()).filter(Boolean) };
  const staticTurn: IceServer[] = env.TURN_URLS
    ? [{ urls: env.TURN_URLS.split(",").map((s) => s.trim()), username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL }]
    : [];

  const keyId = env.CLOUDFLARE_TURN_KEY_ID;
  const token = env.CLOUDFLARE_TURN_API_TOKEN;
  let cached: { servers: IceServer[]; refreshAt: number } | null = null;
  let inflight: Promise<IceServer[] | null> | null = null;

  const fetchCloudflare = async (): Promise<IceServer[] | null> => {
    try {
      const res = await fetchImpl(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ ttl: CREDENTIAL_TTL_S }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const servers = normalize(await res.json());
      if (!servers.length) throw new Error("no usable ICE servers in response");
      cached = { servers, refreshAt: now() + CREDENTIAL_TTL_S * 1000 - REFRESH_BEFORE_EXPIRY_MS };
      return servers;
    } catch (err) {
      console.warn("Cloudflare TURN credentials unavailable:", (err as Error).message);
      return null;
    }
  };

  return {
    /** Which TURN source is configured, for the startup log. */
    describe(): string {
      if (keyId && token) return "Cloudflare TURN";
      if (staticTurn.length) return "TURN próprio";
      return "somente STUN (configure TURN em produção)";
    },

    async getIceServers(): Promise<IceServer[]> {
      if (keyId && token) {
        if (cached && now() < cached.refreshAt) return cached.servers;
        inflight ??= fetchCloudflare().finally(() => (inflight = null));
        const fresh = await inflight;
        // On an API hiccup, keep using credentials that are still valid rather than dropping TURN.
        const servers = fresh ?? (cached && now() < cached.refreshAt + REFRESH_BEFORE_EXPIRY_MS ? cached.servers : null);
        if (servers) return servers.some((s) => !s.username) ? servers : [stun, ...servers];
      }
      return [stun, ...staticTurn];
    },
  };
}

export type IceProvider = ReturnType<typeof createIceProvider>;
