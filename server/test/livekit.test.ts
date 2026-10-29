import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { io as connect, type Socket } from "socket.io-client";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { createLiveKit, liveKitToken } from "../src/livekit.ts";

const decode = (jwt: string) => {
  const [h, p, s] = jwt.split(".");
  return { header: JSON.parse(Buffer.from(h, "base64url").toString()), payload: JSON.parse(Buffer.from(p, "base64url").toString()), signed: `${h}.${p}`, s };
};

describe("LiveKit tokens", () => {
  it("are HS256 JWTs for one room and identity, signed with the secret", () => {
    const t = decode(liveKitToken("APIkey", "segredo", "canal-1", "sock-1", "Ana", 60, 1_700_000_000_000));
    expect(t.header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(t.payload).toEqual({
      iss: "APIkey",
      sub: "sock-1",
      name: "Ana",
      nbf: 1_700_000_000,
      iat: 1_700_000_000,
      exp: 1_700_000_060,
      video: { room: "canal-1", roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false },
    });
    expect(t.s).toBe(createHmac("sha256", "segredo").update(t.signed).digest("base64url"));
  });

  it("is off unless all three settings are there", () => {
    expect(createLiveKit({ LIVEKIT_URL: "wss://x", LIVEKIT_API_KEY: "k" })).toBeNull();
    expect(createLiveKit({ LIVEKIT_URL: "wss://x", LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "s" })?.url).toBe("wss://x");
  });
});

describe("joining voice with a media server", () => {
  let base = "";
  let close: () => Promise<void>;
  beforeAll(async () => {
    const { http, io } = createApp({ db: openDb(":memory:"), sfu: createLiveKit({ LIVEKIT_URL: "wss://lk.example", LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "s" }) });
    await new Promise<void>((r) => http.listen(0, r));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    close = () => new Promise((r) => io.close(() => r()));
  });
  afterAll(() => close());

  it("hands out a token for that channel only to who may join it", async () => {
    const post = async (path: string, body: unknown, token?: string) =>
      (await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })).json();
    const me = await post("/api/auth/register", { username: "lk_ana", password: "senha-segura" });
    const created = await post("/api/servers", { name: "LK" }, me.token);
    const voice = created.channels.find((c: { type: string }) => c.type === "voice");
    const s: Socket = await new Promise((resolve) => {
      const x = connect(base, { auth: { token: me.token }, transports: ["websocket"] });
      x.on("connect", () => resolve(x));
    });
    const r = await new Promise<{ sfu?: { url: string; token: string } }>((res) => s.emit("voice:join", { channelId: voice.id }, res));
    expect(r.sfu?.url).toBe("wss://lk.example");
    expect(decode(r.sfu!.token).payload).toMatchObject({ sub: s.id, name: "lk_ana", video: { room: voice.id } });
    const text = created.channels.find((c: { type: string }) => c.type === "text");
    expect(await new Promise((res) => s.emit("voice:join", { channelId: text.id }, res))).toEqual({ error: expect.any(String) });
    s.close();
  });
});
