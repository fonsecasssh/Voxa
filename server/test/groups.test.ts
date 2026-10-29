import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { io as connect, type Socket } from "socket.io-client";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";

let base = "";
let close: () => Promise<void>;
const db = openDb(":memory:");
const groupExists = (id: string) => db.prepare("SELECT 1 FROM channels WHERE id = ?").get(id) !== undefined;

beforeAll(async () => {
  const { http, io } = createApp({ db });
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
async function register(username: string): Promise<Account> {
  const r = await api("POST", "/api/auth/register", { username, password: "senha-segura" });
  expect(r.status).toBe(201);
  return r.body;
}
async function befriend(a: Account, b: Account) {
  await api("POST", "/api/friends", { username: b.user.username }, a.token);
  await api("POST", `/api/friends/${a.user.id}/accept`, undefined, b.token);
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
const join = (s: Socket, channelId: string) =>
  new Promise<{ error?: string; peers?: { socketId: string }[] }>((r) => s.emit("voice:join", { channelId }, r));

describe("group DMs", () => {
  it("creates a group with friends only, renames, adds, removes and hands it over", async () => {
    const [ana, bia, caio, duda, rui] = await Promise.all(["g_ana", "g_bia", "g_caio", "g_duda", "g_rui"].map(register));
    await befriend(ana, bia);
    await befriend(ana, caio);
    await befriend(bia, duda);

    // Only friends can be added.
    expect((await api("POST", "/api/dms/group", { userIds: [bia.user.id, rui.user.id] }, ana.token)).status).toBe(403);
    expect((await api("POST", "/api/dms/group", { userIds: [] }, ana.token)).status).toBe(400);

    const sb = await socketFor(bia.token);
    const dmNew = next<{ group: { ownerId: string }; members: { username: string }[] }>(sb, "dm:new");
    const created = await api("POST", "/api/dms/group", { userIds: [bia.user.id, caio.user.id], name: " Squad " }, ana.token);
    expect(created.status).toBe(201);
    const id = created.body.dm.channel.id;
    expect(created.body.dm).toMatchObject({ user: null, group: { name: "Squad", ownerId: ana.user.id } });
    expect(created.body.dm.members.map((u: { username: string }) => u.username)).toEqual(["g_bia", "g_caio"]);
    expect((await dmNew).members.map((u) => u.username)).toEqual(["g_ana", "g_caio"]);

    // Messages reach everyone in it; outsiders get a 404.
    expect((await api("POST", `/api/channels/${id}/messages`, { content: "oi grupo" }, caio.token)).status).toBe(201);
    expect((await api("GET", `/api/channels/${id}/messages`, undefined, bia.token)).body.messages).toHaveLength(1);
    expect((await api("GET", `/api/channels/${id}/messages`, undefined, rui.token)).status).toBe(404);

    // Anyone in it can rename it.
    const renamed = next<{ group: { name: string } }>(sb, "dm:update");
    expect((await api("PATCH", `/api/dms/${id}`, { name: "Rankeada" }, caio.token)).status).toBe(200);
    expect((await renamed).group.name).toBe("Rankeada");

    // Bia adds her friend Duda; Ana can't add Rui (not her friend).
    expect((await api("POST", `/api/dms/${id}/members`, { userId: rui.user.id }, ana.token)).status).toBe(403);
    expect((await api("POST", `/api/dms/${id}/members`, { userId: duda.user.id }, bia.token)).status).toBe(200);
    expect((await api("GET", `/api/channels/${id}/messages`, undefined, duda.token)).status).toBe(200);

    // Only the owner removes others; anyone can leave.
    expect((await api("DELETE", `/api/dms/${id}/members/${caio.user.id}`, undefined, bia.token)).status).toBe(403);
    const sc = await socketFor(caio.token);
    const removed = next<{ channelId: string }>(sc, "dm:remove");
    expect((await api("DELETE", `/api/dms/${id}/members/${caio.user.id}`, undefined, ana.token)).status).toBe(204);
    expect((await removed).channelId).toBe(id);
    expect((await api("GET", `/api/channels/${id}/messages`, undefined, caio.token)).status).toBe(404);

    // The owner leaving hands the group to who joined first.
    expect((await api("DELETE", `/api/dms/${id}/members/${ana.user.id}`, undefined, ana.token)).status).toBe(204);
    const list = await api("GET", "/api/dms", undefined, bia.token);
    const group = list.body.dms.find((d: { channel: { id: string } }) => d.channel.id === id);
    expect(group.group.ownerId).toBe(bia.user.id);
    expect(group.members.map((u: { username: string }) => u.username)).toEqual(["g_duda"]);

    // The last one out deletes it.
    await api("DELETE", `/api/dms/${id}/members/${duda.user.id}`, undefined, duda.token);
    await api("DELETE", `/api/dms/${id}/members/${bia.user.id}`, undefined, bia.token);
    expect((await api("GET", `/api/channels/${id}/messages`, undefined, bia.token)).status).toBe(404);
    expect(groupExists(id)).toBe(false);
    sb.close();
    sc.close();
  });

  it("limits a group to 10 people", async () => {
    const owner = await register("lim_owner");
    const friends = await Promise.all(Array.from({ length: 10 }, (_, i) => register(`lim_${i}`)));
    for (const f of friends) await befriend(owner, f);
    const ids = friends.map((f) => f.user.id);
    expect((await api("POST", "/api/dms/group", { userIds: ids }, owner.token)).status).toBe(400);
    const ok = await api("POST", "/api/dms/group", { userIds: ids.slice(0, 9) }, owner.token);
    expect(ok.status).toBe(201);
    expect((await api("POST", `/api/dms/${ok.body.dm.channel.id}/members`, { userId: ids[9] }, owner.token)).status).toBe(400);
  });
});

describe("calls in DMs", () => {
  it("rings the other person, lists the call, and keeps outsiders out", async () => {
    const [a, b, x] = await Promise.all(["c_a", "c_b", "c_x"].map(register));
    await befriend(a, b);
    const dm = (await api("POST", "/api/dms", { userId: b.user.id }, a.token)).body.dm;
    const sa = await socketFor(a.token);
    const sb = await socketFor(b.token);
    const sx = await socketFor(x.token);
    let outsiderHeard = false;
    sx.on("voice:update", () => (outsiderHeard = true));
    sx.on("call:ring", () => (outsiderHeard = true));
    let callerRang = false;
    sa.on("call:ring", () => (callerRang = true));

    expect((await join(sx, dm.channel.id)).error).toBeTruthy();

    const ring = next<{ channelId: string; from: { username: string } }>(sb, "call:ring");
    const update = next<{ serverId: string | null; members: unknown[] }>(sb, "voice:update");
    expect((await join(sa, dm.channel.id)).peers).toEqual([]);
    expect(await ring).toMatchObject({ channelId: dm.channel.id, from: { username: "c_a" } });
    expect(await update).toMatchObject({ serverId: null, members: [expect.objectContaining({ cameraStreamId: null })] });

    // Shown on page load too.
    const list = await api("GET", "/api/dms", undefined, b.token);
    expect(list.body.calls[dm.channel.id]).toHaveLength(1);

    // Answering doesn't ring again; camera state is relayed.
    let rangTwice = false;
    sa.on("call:ring", () => (rangTwice = true));
    expect((await join(sb, dm.channel.id)).peers!.map((p) => p.socketId)).toEqual([sa.id]);
    const cam = next<{ members: { cameraStreamId: string | null; user: { username: string } }[] }>(sb, "voice:update", (p) =>
      p.members.some((m) => m.cameraStreamId),
    );
    sa.emit("voice:state", { muted: false, deafened: false, screenStreamId: null, cameraStreamId: "cam-1" });
    expect((await cam).members.find((m) => m.user.username === "c_a")!.cameraStreamId).toBe("cam-1");

    await new Promise((r) => setTimeout(r, 100));
    expect(outsiderHeard).toBe(false);
    expect(callerRang).toBe(false);
    expect(rangTwice).toBe(false);
    for (const s of [sa, sb, sx]) s.close();
  });

  it("drops someone removed from a group out of its call", async () => {
    const [o, m] = await Promise.all(["k_owner", "k_member"].map(register));
    await befriend(o, m);
    const id = (await api("POST", "/api/dms/group", { userIds: [m.user.id] }, o.token)).body.dm.channel.id;
    const so = await socketFor(o.token);
    const sm = await socketFor(m.token);
    await join(so, id);
    await join(sm, id);
    const kicked = next<{ reason: string }>(sm, "voice:kicked");
    const left = next<{ members: unknown[] }>(so, "voice:update", (p) => p.members.length === 1);
    await api("DELETE", `/api/dms/${id}/members/${m.user.id}`, undefined, o.token);
    expect((await kicked).reason).toMatch(/removido/);
    await left;
    so.close();
    sm.close();
  });
});
