import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
  return r.body as { token: string; user: { id: string; username: string } };
}

function socketFor(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect(base, { auth: { token }, transports: ["websocket"] });
    s.on("connect", () => resolve(s));
    s.on("connect_error", reject);
  });
}

const next = <T>(s: Socket, event: string, match: (p: T) => boolean = () => true) =>
  new Promise<T>((resolve) => {
    const handler = (p: T) => {
      if (!match(p)) return;
      s.off(event, handler);
      resolve(p);
    };
    s.on(event, handler);
  });

describe("friends", () => {
  it("sends, accepts and removes friend requests with live updates", async () => {
    const ana = await register("f_ana");
    const bia = await register("f_bia");
    const sa = await socketFor(ana.token);
    const sb = await socketFor(bia.token);

    expect((await api("POST", "/api/friends", { username: "ninguem" }, ana.token)).status).toBe(404);
    expect((await api("POST", "/api/friends", { username: "f_ana" }, ana.token)).status).toBe(400);

    const incoming = next<{ state: string; user: { username: string } }>(sb, "friend:update");
    expect((await api("POST", "/api/friends", { username: "@F_BIA" }, ana.token)).body.state).toBe("outgoing");
    expect(await incoming).toMatchObject({ state: "incoming", user: { username: "f_ana" } });
    expect((await api("POST", "/api/friends", { username: "f_bia" }, ana.token)).status).toBe(409);

    // Only the receiver can accept.
    expect((await api("POST", `/api/friends/${bia.user.id}/accept`, undefined, ana.token)).status).toBe(404);
    const accepted = next<{ state: string; presence: { status: string } }>(sa, "friend:update");
    expect((await api("POST", `/api/friends/${ana.user.id}/accept`, undefined, bia.token)).status).toBe(200);
    expect(await accepted).toMatchObject({ state: "accepted", presence: { status: "online" } });

    const list = await api("GET", "/api/friends", undefined, ana.token);
    expect(list.body.friends).toEqual([{ user: expect.objectContaining({ username: "f_bia" }), state: "accepted" }]);
    expect(list.body.presence[bia.user.id].status).toBe("online");

    const removed = next<{ state: null }>(sb, "friend:update");
    expect((await api("DELETE", `/api/friends/${bia.user.id}`, undefined, ana.token)).status).toBe(204);
    expect((await removed).state).toBeNull();
    expect((await api("GET", "/api/friends", undefined, bia.token)).body.friends).toEqual([]);
    sa.close();
    sb.close();
  });

  it("accepts automatically when both sides send a request", async () => {
    const a = await register("mutual_a");
    const b = await register("mutual_b");
    await api("POST", "/api/friends", { username: "mutual_b" }, a.token);
    expect((await api("POST", "/api/friends", { username: "mutual_a" }, b.token)).body.state).toBe("accepted");
  });
});

describe("direct messages", () => {
  it("only opens DMs between friends or server-mates, and delivers privately", async () => {
    const a = await register("dm_a");
    const b = await register("dm_b");
    const outsider = await register("dm_x");

    expect((await api("POST", "/api/dms", { userId: b.user.id }, a.token)).status).toBe(403);
    await api("POST", "/api/friends", { username: "dm_b" }, a.token);
    await api("POST", `/api/friends/${a.user.id}/accept`, undefined, b.token);

    const sb = await socketFor(b.token);
    const sx = await socketFor(outsider.token);
    let outsiderSaw = false;
    sx.on("message:new", () => (outsiderSaw = true));

    const dmNew = next<{ user: { username: string } }>(sb, "dm:new");
    const opened = await api("POST", "/api/dms", { userId: b.user.id }, a.token);
    expect(opened.status).toBe(201);
    expect(opened.body.dm.user.username).toBe("dm_b");
    expect((await dmNew).user.username).toBe("dm_a");
    // Opening again returns the same conversation.
    const again = await api("POST", "/api/dms", { userId: a.user.id }, b.token);
    expect(again.status).toBe(200);
    expect(again.body.dm.channel.id).toBe(opened.body.dm.channel.id);

    const channelId = opened.body.dm.channel.id;
    const typing = next<{ channelId: string }>(sb, "typing");
    const sa = await socketFor(a.token);
    sa.emit("typing", { channelId });
    expect((await typing).channelId).toBe(channelId);

    const got = next<{ content: string }>(sb, "message:new");
    await api("POST", `/api/channels/${channelId}/messages`, { content: "oi, só pra você" }, a.token);
    expect((await got).content).toBe("oi, só pra você");

    expect((await api("GET", `/api/channels/${channelId}/messages`, undefined, outsider.token)).status).toBe(404);
    expect((await api("POST", `/api/channels/${channelId}/messages`, { content: "x" }, outsider.token)).status).toBe(404);
    expect(outsiderSaw).toBe(false);

    const dms = await api("GET", "/api/dms", undefined, b.token);
    expect(dms.body.dms).toHaveLength(1);
    expect(dms.body.dms[0].lastMessageAt).toBeGreaterThan(0);
    sa.close();
    sb.close();
    sx.close();
  });
});

describe("presence", () => {
  it("broadcasts status and activity, and hides invisible users", async () => {
    const a = await register("p_a");
    const b = await register("p_b");
    await api("POST", "/api/friends", { username: "p_b" }, a.token);
    await api("POST", `/api/friends/${a.user.id}/accept`, undefined, b.token);
    const sb = await socketFor(b.token);

    type P = { userId: string; presence: { status: string; activity: { name: string } | null } };
    const forA = (p: P) => p.userId === a.user.id;

    const online = next<P>(sb, "presence", forA);
    const sa = await socketFor(a.token);
    expect((await online).presence.status).toBe("online");

    const dnd = next<P>(sb, "presence", forA);
    await api("PATCH", "/api/me/presence", { status: "dnd" }, a.token);
    expect((await dnd).presence.status).toBe("dnd");

    const playing = next<P>(sb, "presence", forA);
    await api("PATCH", "/api/me/presence", { activity: "Valorant" }, a.token);
    expect((await playing).presence).toMatchObject({ status: "dnd", activity: { name: "Valorant" } });

    const invisible = next<P>(sb, "presence", forA);
    await api("PATCH", "/api/me/presence", { status: "invisible" }, a.token);
    expect((await invisible).presence).toEqual({ status: "offline", activity: null });
    expect((await api("GET", "/api/me", undefined, a.token)).body.status).toBe("invisible");
    expect((await api("PATCH", "/api/me/presence", { status: "away" }, a.token)).status).toBe(400);

    await api("PATCH", "/api/me/presence", { status: "online" }, a.token);
    const offline = next<P>(sb, "presence", (p) => forA(p) && p.presence.status === "offline");
    sa.close();
    expect((await offline).presence.activity).toBeNull();

    // The activity is kept across reconnects (e.g. a page reload).
    const back = next<P>(sb, "presence", (p) => forA(p) && p.presence.status === "online");
    const sa2 = await socketFor(a.token);
    expect((await back).presence.activity?.name).toBe("Valorant");
    sa2.close();
    sb.close();
  });
});

describe("migrations", () => {
  it("upgrades a stage-1 database without losing data", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "voxa-")), "old.db");
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id), invite_code TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE channels (id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE, name TEXT NOT NULL, type TEXT NOT NULL CHECK (type IN ('text', 'voice')), position INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE messages (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, author_id TEXT NOT NULL REFERENCES users(id), content TEXT NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO users VALUES ('u1', 'velho', 'Velho', 'x:y', 1);
      INSERT INTO servers VALUES ('s1', 'Antigo', 'u1', 'abc', 1);
      INSERT INTO channels VALUES ('c1', 's1', 'geral', 'text', 0, 1);
      INSERT INTO messages VALUES ('m1', 'c1', 'u1', 'mensagem antiga', 1);
    `);
    old.close();

    const db = openDb(file);
    expect(db.prepare("SELECT content FROM messages").all()).toEqual([{ content: "mensagem antiga" }]);
    expect(db.prepare("SELECT status FROM users").get()).toEqual({ status: "online" });
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(6);
    // The old server got its @everyone role.
    expect(db.prepare("SELECT name, is_default, permissions FROM roles WHERE server_id = 's1'").all()).toEqual([
      { name: "@everyone", is_default: 1, permissions: 64 },
    ]);
    // Re-opening is a no-op.
    db.close();
    openDb(file).close();
  });
});
