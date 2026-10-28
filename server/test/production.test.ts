import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { createIceProvider } from "../src/ice.ts";

describe("ICE provider", () => {
  const cloudflareEnv = { CLOUDFLARE_TURN_KEY_ID: "key", CLOUDFLARE_TURN_API_TOKEN: "secret" };
  const response = (body: unknown, status = 201) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

  it("uses public STUN only when nothing is configured", async () => {
    const ice = createIceProvider({});
    expect(await ice.getIceServers()).toEqual([{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }]);
    expect(ice.describe()).toMatch(/STUN/);
  });

  it("adds a static TURN server from env", async () => {
    const ice = createIceProvider({ TURN_URLS: "turn:t.example:3478", TURN_USERNAME: "u", TURN_CREDENTIAL: "p" });
    expect((await ice.getIceServers())[1]).toEqual({ urls: ["turn:t.example:3478"], username: "u", credential: "p" });
  });

  it("generates Cloudflare credentials server-side, drops port 53 and caches them", async () => {
    const fetchMock = vi.fn(() =>
      response({
        iceServers: [
          { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
          {
            urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:53?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"],
            username: "user",
            credential: "pass",
          },
        ],
      }),
    );
    let t = 0;
    const ice = createIceProvider(cloudflareEnv, fetchMock as unknown as typeof fetch, () => t);
    const servers = await ice.getIceServers();
    expect(servers).toEqual([
      { urls: ["stun:stun.cloudflare.com:3478"] },
      { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"], username: "user", credential: "pass" },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://rtc.live.cloudflare.com/v1/turn/keys/key/credentials/generate-ice-servers");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret");

    await ice.getIceServers();
    expect(fetchMock).toHaveBeenCalledTimes(1); // cached
    t += 20 * 60 * 60 * 1000; // past the refresh point
    await ice.getIceServers();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("accepts the older single-object response shape", async () => {
    const fetchMock = vi.fn(() => response({ iceServers: { urls: ["turn:turn.cloudflare.com:3478"], username: "u", credential: "c" } }));
    const servers = await createIceProvider(cloudflareEnv, fetchMock as unknown as typeof fetch).getIceServers();
    // No credential-less entry came back, so public STUN is added in front.
    expect(servers[0].urls).toContain("stun:stun.l.google.com:19302");
    expect(servers[1]).toEqual({ urls: ["turn:turn.cloudflare.com:3478"], username: "u", credential: "c" });
  });

  it("falls back to STUN when Cloudflare fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn(() => response({ error: "nope" }, 401));
    const servers = await createIceProvider(cloudflareEnv, fetchMock as unknown as typeof fetch).getIceServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].username).toBeUndefined();
    warn.mockRestore();
  });
});

describe("production hardening", () => {
  let base = "";
  let close: () => Promise<void>;

  beforeAll(async () => {
    const { http, io } = createApp({ db: openDb(":memory:"), ice: createIceProvider({}), signupsPerHour: 3 });
    await new Promise<void>((r) => http.listen(0, r));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    close = () => new Promise((r) => io.close(() => r()));
  });
  afterAll(() => close());

  it("answers the health check with the caller's IP", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ip: expect.stringContaining("127.0.0.1") });
  });

  it("sends security headers", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-powered-by")).toBeNull();
  });

  it("limits signups per address when enabled", async () => {
    const signup = (username: string) =>
      fetch(`${base}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password: "senha-certa" }),
      }).then((r) => r.status);
    expect([await signup("alvo"), await signup("outro"), await signup("terceiro"), await signup("quarto")]).toEqual([201, 201, 201, 429]);
  });

  it("blocks an account after too many wrong passwords, without affecting others", async () => {
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    // "alvo" and "outro" were created by the signup test above.

    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await post("/api/auth/login", { username: "ALVO", password: "errada!!" })).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
    // Even the right password waits until the window ends.
    expect((await post("/api/auth/login", { username: "alvo", password: "senha-certa" })).status).toBe(429);
    // Other accounts are unaffected.
    expect((await post("/api/auth/login", { username: "outro", password: "senha-certa" })).status).toBe(200);
  });
});
