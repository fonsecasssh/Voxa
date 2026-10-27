import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { io as connect, type Socket } from "socket.io-client";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";

let base = "";
let close: () => Promise<void>;

beforeAll(async () => {
  const { http, io } = createApp({ db: openDb(":memory:") });
  await new Promise<void>((r) => http.listen(0, r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  close = () => new Promise((r) => io.close(() => r()));
});

afterAll(() => close());

async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function register(username: string) {
  const r = await api("POST", "/api/auth/register", { username, password: "senha-segura" });
  expect(r.status).toBe(201);
  return r.body as { token: string; user: { id: string } };
}

function socketFor(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect(base, { auth: { token }, transports: ["websocket"] });
    s.on("connect", () => resolve(s));
    s.on("connect_error", reject);
  });
}

const next = <T>(s: Socket, event: string) => new Promise<T>((r) => s.once(event, r));

describe("auth", () => {
  it("registers, logs in and rejects bad credentials", async () => {
    await register("alice");
    expect((await api("POST", "/api/auth/register", { username: "ALICE", password: "outra-senha" })).status).toBe(409);
    expect((await api("POST", "/api/auth/login", { username: "alice", password: "errada!!" })).status).toBe(401);
    const ok = await api("POST", "/api/auth/login", { username: "alice", password: "senha-segura" });
    expect(ok.status).toBe(200);
    const me = await api("GET", "/api/me", undefined, ok.body.token);
    expect(me.body.user.username).toBe("alice");
  });

  it("validates input", async () => {
    expect((await api("POST", "/api/auth/register", { username: "x", password: "senha-segura" })).status).toBe(400);
    expect((await api("POST", "/api/auth/register", { username: "bob", password: "curta" })).status).toBe(400);
    expect((await api("GET", "/api/me")).status).toBe(401);
  });

  it("invalidates the token on logout", async () => {
    const { token } = await register("logout_user");
    expect((await api("POST", "/api/auth/logout", undefined, token)).status).toBe(204);
    expect((await api("GET", "/api/me", undefined, token)).status).toBe(401);
  });
});

describe("servers, invites and messages", () => {
  it("runs the whole flow with realtime delivery", async () => {
    const owner = await register("dono");
    const guest = await register("convidado");

    const created = await api("POST", "/api/servers", { name: "Meu servidor" }, owner.token);
    expect(created.status).toBe(201);
    const { server, channels } = created.body;
    expect(channels.map((c: { type: string }) => c.type)).toEqual(["text", "voice"]);
    const textChannel = channels[0];

    // Non-members can't see the server or its messages.
    expect((await api("GET", `/api/servers/${server.id}`, undefined, guest.token)).status).toBe(404);
    expect((await api("GET", `/api/channels/${textChannel.id}/messages`, undefined, guest.token)).status).toBe(404);

    const ownerSocket = await socketFor(owner.token);
    const guestSocket = await socketFor(guest.token);

    const joined = next<{ user: { username: string } }>(ownerSocket, "member:join");
    expect((await api("GET", `/api/invites/${server.inviteCode}`)).body.server.name).toBe("Meu servidor");
    expect((await api("POST", `/api/invites/${server.inviteCode}`, undefined, guest.token)).status).toBe(200);
    expect((await joined).user.username).toBe("convidado");

    // The guest's already-open socket was moved into the server room.
    const received = next<{ content: string; author: { username: string } }>(guestSocket, "message:new");
    const sent = await api("POST", `/api/channels/${textChannel.id}/messages`, { content: "olá!" }, owner.token);
    expect(sent.status).toBe(201);
    const msg = await received;
    expect(msg.content).toBe("olá!");
    expect(msg.author.username).toBe("dono");

    // Only the owner creates channels; text names are slugified.
    expect((await api("POST", `/api/servers/${server.id}/channels`, { name: "x" }, guest.token)).status).toBe(403);
    const newChannel = next<{ name: string }>(guestSocket, "channel:new");
    await api("POST", `/api/servers/${server.id}/channels`, { name: "Jogos Online" }, owner.token);
    expect((await newChannel).name).toBe("jogos-online");

    const typing = next<{ user: { username: string } }>(ownerSocket, "typing");
    guestSocket.emit("typing", { channelId: textChannel.id });
    expect((await typing).user.username).toBe("convidado");

    const details = await api("GET", `/api/servers/${server.id}`, undefined, guest.token);
    expect(details.body.members).toHaveLength(2);
    expect(Object.keys(details.body.presence).sort()).toEqual([owner.user.id, guest.user.id].sort());
    expect(details.body.presence[owner.user.id].status).toBe("online");

    const history = await api("GET", `/api/channels/${textChannel.id}/messages`, undefined, guest.token);
    expect(history.body.messages.map((m: { content: string }) => m.content)).toEqual(["olá!"]);

    ownerSocket.close();
    guestSocket.close();
  });

  it("tracks voice channels and relays signaling only within one", async () => {
    const a = await register("voz_a");
    const b = await register("voz_b");
    const { body } = await api("POST", "/api/servers", { name: "Voz" }, a.token);
    const voiceChannel = body.channels.find((c: { type: string }) => c.type === "voice");
    const textChannel = body.channels.find((c: { type: string }) => c.type === "text");
    await api("POST", `/api/invites/${body.server.inviteCode}`, undefined, b.token);

    const sa = await socketFor(a.token);
    const sb = await socketFor(b.token);
    const join = (s: Socket, channelId: string) =>
      new Promise<{ error?: string; peers?: { socketId: string }[] }>((r) => s.emit("voice:join", { channelId }, r));

    expect((await join(sa, textChannel.id)).error).toBeTruthy();
    expect((await join(sa, voiceChannel.id)).peers).toEqual([]);

    const update = next<{ members: { user: { username: string } }[] }>(sa, "voice:update");
    const joinB = await join(sb, voiceChannel.id);
    expect(joinB.peers!.map((p) => p.socketId)).toEqual([sa.id]);
    expect((await update).members.map((m) => m.user.username).sort()).toEqual(["voz_a", "voz_b"]);

    const signal = next<{ from: string; data: unknown }>(sa, "voice:signal");
    sb.emit("voice:signal", { to: sa.id, data: { description: "offer" } });
    expect(await signal).toEqual({ from: sb.id, data: { description: "offer" } });

    const muted = next<{ members: { muted: boolean; user: { username: string } }[] }>(sa, "voice:update");
    sb.emit("voice:state", { muted: true });
    expect((await muted).members.find((m) => m.user.username === "voz_b")!.muted).toBe(true);

    const details = await api("GET", `/api/servers/${body.server.id}`, undefined, a.token);
    expect(details.body.voice[voiceChannel.id]).toHaveLength(2);

    // A second socket of the same user takes over the session.
    const sb2 = await socketFor(b.token);
    const replaced = next(sb, "voice:replaced");
    await join(sb2, voiceChannel.id);
    await replaced;

    // Leaving (here: disconnecting) empties the channel for everyone else.
    const emptied = next<{ members: unknown[] }>(sa, "voice:update");
    sb2.close();
    expect((await emptied).members).toHaveLength(1);

    expect((await api("GET", "/api/rtc-config", undefined, a.token)).body.iceServers.length).toBeGreaterThan(0);
    sa.close();
    sb.close();
  });

  it("rejects sockets without a valid token", async () => {
    await expect(socketFor("nope")).rejects.toThrow("unauthorized");
  });
});
