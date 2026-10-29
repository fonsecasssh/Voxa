import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { io as connect, type Socket } from "socket.io-client";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import type { PushPayload } from "../src/push.ts";

let base = "";
let close: () => Promise<void>;
const pushed: { endpoint: string; payload: PushPayload }[] = [];
let gone = new Set<string>();

beforeAll(async () => {
  const { http, io } = createApp({
    db: openDb(":memory:"),
    push: {
      publicKey: "BPublicKey",
      send: async (sub, payload) => {
        if (gone.has(sub.endpoint)) return "gone";
        pushed.push({ endpoint: sub.endpoint, payload });
        return "ok";
      },
    },
  });
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
type Account = { token: string; user: { id: string; username: string } };
const register = async (username: string): Promise<Account> => (await api("POST", "/api/auth/register", { username, password: "senha-segura" })).body;
const socketFor = (token: string): Promise<Socket> =>
  new Promise((resolve) => {
    const s = connect(base, { auth: { token }, transports: ["websocket"] });
    s.on("connect", () => resolve(s));
  });
const settle = () => new Promise((r) => setTimeout(r, 60));
const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: "p256dh-key-123", auth: "auth-key-12" } });

async function setup(prefix: string) {
  const owner = await register(`${prefix}_dono`);
  const member = await register(`${prefix}_membro`);
  const { body } = await api("POST", "/api/servers", { name: prefix }, owner.token);
  await api("POST", `/api/invites/${body.inviteCode}`, undefined, member.token);
  const text = body.channels.find((c: { type: string }) => c.type === "text");
  return { owner, member, server: body.server, text };
}

describe("unread and read state", () => {
  it("counts unread and mentions per channel, survives reloads and syncs reading across devices", async () => {
    const { owner, member, text } = await setup("rd");
    expect((await api("GET", "/api/me", undefined, member.token)).body.unread).toEqual({});
    await api("POST", `/api/channels/${text.id}/messages`, { content: "oi" }, owner.token);
    await api("POST", `/api/channels/${text.id}/messages`, { content: "@rd_membro olha" }, owner.token);
    expect((await api("GET", "/api/me", undefined, member.token)).body.unread).toEqual({ [text.id]: { mentions: 1, serverId: expect.any(String) } });
    // Sending marks your read up to then: nothing is unread anymore.
    await api("POST", `/api/channels/${text.id}/messages`, { content: "eu" }, member.token);
    const page = await api("GET", `/api/channels/${text.id}/messages`, undefined, member.token);
    expect(page.body.lastReadAt).toBeGreaterThan(0);
    expect((await api("GET", "/api/me", undefined, member.token)).body.unread).toEqual({});

    await api("POST", `/api/channels/${text.id}/messages`, { content: "mais uma" }, owner.token);
    const other = await socketFor(member.token);
    const read = new Promise<{ channelId: string; at: number }>((r) => other.once("channel:read", r));
    const last = (await api("GET", `/api/channels/${text.id}/messages`, undefined, member.token)).body.messages.at(-1);
    expect((await api("POST", `/api/channels/${text.id}/read`, { at: last.createdAt }, member.token)).body.lastReadAt).toBe(last.createdAt);
    expect(await read).toEqual({ channelId: text.id, at: last.createdAt });
    // Never backwards.
    expect((await api("POST", `/api/channels/${text.id}/read`, { at: 1 }, member.token)).body.lastReadAt).toBe(last.createdAt);
    other.close();
  });
});

describe("notification settings and push", () => {
  it("pushes to closed devices per the settings, never while online, and forgets dead subscriptions", async () => {
    const { owner, member, server, text } = await setup("ps");
    expect((await api("GET", "/api/push/key", undefined, member.token)).body.publicKey).toBe("BPublicKey");
    expect((await api("POST", "/api/push/subscribe", { endpoint: "http://inseguro", keys: sub("x").keys }, member.token)).status).toBe(400);
    expect((await api("POST", "/api/push/subscribe", sub("https://push.example/celular"), member.token)).status).toBe(204);

    // Servers notify only mentions by default.
    await api("POST", `/api/channels/${text.id}/messages`, { content: "sem menção" }, owner.token);
    await api("POST", `/api/channels/${text.id}/messages`, { content: "@ps_membro bora?" }, owner.token);
    await settle();
    expect(pushed.map((p) => p.payload.body)).toEqual(["@ps_membro bora?"]);
    expect(pushed[0].payload).toMatchObject({ title: "ps_dono em #geral (ps)", url: `/channels/${server.id}/${text.id}`, tag: text.id });

    // "All messages" for the server; muting the channel wins.
    await api("PUT", `/api/notify/${server.id}`, { level: "all" }, member.token);
    await api("POST", `/api/channels/${text.id}/messages`, { content: "tudo" }, owner.token);
    await settle();
    expect(pushed.at(-1)!.payload.body).toBe("tudo");
    const updated = await api("PUT", `/api/notify/${text.id}`, { mutedUntil: Date.now() + 3600_000 }, member.token);
    expect(updated.body.notify[text.id].mutedUntil).toBeGreaterThan(Date.now());
    const before = pushed.length;
    await api("POST", `/api/channels/${text.id}/messages`, { content: "@ps_membro silêncio" }, owner.token);
    await settle();
    expect(pushed.length).toBe(before);
    expect((await api("PUT", `/api/notify/${text.id}`, { level: "nada" }, member.token)).status).toBe(400);
    const stranger = await register("ps_estranho");
    expect((await api("PUT", `/api/notify/${server.id}`, { level: "all" }, stranger.token)).status).toBe(404);
    await api("PUT", `/api/notify/${text.id}`, { level: null, mutedUntil: null }, member.token);

    // Online somewhere: no push.
    const s = await socketFor(member.token);
    await api("POST", `/api/channels/${text.id}/messages`, { content: "estou online" }, owner.token);
    await settle();
    expect(pushed.at(-1)!.payload.body).not.toBe("estou online");
    s.close();
    await settle();

    // A subscription the browser dropped is forgotten.
    gone = new Set(["https://push.example/celular"]);
    await api("POST", `/api/channels/${text.id}/messages`, { content: "sumiu" }, owner.token);
    await settle();
    gone = new Set();
    const n = pushed.length;
    await api("POST", `/api/channels/${text.id}/messages`, { content: "de novo" }, owner.token);
    await settle();
    expect(pushed.length).toBe(n);
  });

  it("pushes DMs and rings for calls", async () => {
    const a = await register("pd_a");
    const b = await register("pd_b");
    await api("POST", "/api/friends", { username: "pd_b" }, a.token);
    await api("POST", `/api/friends/${a.user.id}/accept`, undefined, b.token);
    await api("POST", "/api/push/subscribe", sub("https://push.example/b"), b.token);
    const dm = (await api("POST", "/api/dms", { userId: b.user.id }, a.token)).body.dm;
    await api("POST", `/api/channels/${dm.channel.id}/messages`, { content: "e aí" }, a.token);
    const sa = await socketFor(a.token);
    await new Promise((r) => sa.emit("voice:join", { channelId: dm.channel.id }, r));
    await settle();
    const mine = pushed.filter((p) => p.endpoint === "https://push.example/b").map((p) => p.payload);
    expect(mine).toEqual([
      expect.objectContaining({ title: "pd_a", body: "e aí", url: `/channels/@me/${dm.channel.id}` }),
      expect.objectContaining({ title: "pd_a está te ligando", call: true }),
    ]);
    sa.close();
  });
});

describe("blocking", () => {
  it("ends the friendship, stops requests, DMs, calls and notifications, and hides their unread", async () => {
    const a = await register("bl_a");
    const b = await register("bl_b");
    await api("POST", "/api/friends", { username: "bl_b" }, a.token);
    await api("POST", `/api/friends/${a.user.id}/accept`, undefined, b.token);
    const dm = (await api("POST", "/api/dms", { userId: b.user.id }, a.token)).body.dm;
    await api("POST", "/api/push/subscribe", sub("https://push.example/bl-b"), b.token);

    const sb = await socketFor(b.token);
    const blocks = new Promise<{ blocked: string[] }>((r) => sb.once("blocks:update", r));
    expect((await api("PUT", `/api/blocks/${a.user.id}`, undefined, b.token)).status).toBe(204);
    expect((await blocks).blocked).toEqual([a.user.id]);
    sb.close();
    expect((await api("GET", "/api/friends", undefined, a.token)).body.friends).toEqual([]);
    expect((await api("GET", "/api/blocks", undefined, b.token)).body.users.map((u: { username: string }) => u.username)).toEqual(["bl_a"]);
    expect((await api("GET", "/api/me", undefined, b.token)).body.blocked).toEqual([a.user.id]);

    expect((await api("POST", "/api/friends", { username: "bl_b" }, a.token)).status).toBe(403);
    expect((await api("POST", "/api/friends", { username: "bl_a" }, b.token)).status).toBe(403);
    expect((await api("POST", `/api/channels/${dm.channel.id}/messages`, { content: "oi?" }, a.token)).status).toBe(403);
    expect((await api("POST", `/api/channels/${dm.channel.id}/messages`, { content: "oi?" }, b.token)).status).toBe(403);

    // Messages from someone you blocked (e.g. in a shared server) don't count or notify.
    const { body } = await api("POST", "/api/servers", { name: "Comum" }, a.token);
    await api("POST", `/api/invites/${body.inviteCode}`, undefined, b.token);
    const text = body.channels.find((c: { type: string }) => c.type === "text");
    await api("POST", `/api/channels/${text.id}/messages`, { content: "@bl_b oi" }, a.token);
    await settle();
    expect((await api("GET", "/api/me", undefined, b.token)).body.unread[text.id]).toBeUndefined();
    expect(pushed.some((p) => p.endpoint === "https://push.example/bl-b")).toBe(false);

    expect((await api("DELETE", `/api/blocks/${a.user.id}`, undefined, b.token)).status).toBe(204);
    expect((await api("POST", "/api/friends", { username: "bl_b" }, a.token)).status).toBe(201);
  });
});
