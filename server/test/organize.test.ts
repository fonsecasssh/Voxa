import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { io as connect, type Socket } from "socket.io-client";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { Permission } from "../../shared/permissions.ts";

let base = "";
let close: () => Promise<void>;
const db = openDb(":memory:");

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

/** A server with an owner and members who joined through its original invite. */
async function serverWith(prefix: string, memberNames: string[]) {
  const owner = await register(`${prefix}_owner`);
  const members = await Promise.all(memberNames.map((n) => register(`${prefix}_${n}`)));
  const { body } = await api("POST", "/api/servers", { name: prefix }, owner.token);
  for (const m of members) await api("POST", `/api/invites/${body.inviteCode}`, undefined, m.token);
  return { owner, members, server: body.server as { id: string }, categories: body.categories as { id: string; name: string }[], inviteCode: body.inviteCode as string };
}
const names = (r: { body: { channels: { name: string }[] } }) => r.body.channels.map((c) => c.name);

describe("categories", () => {
  it("starts with text and voice categories, and lets managers organize channels", async () => {
    const { owner, members, server, categories } = await serverWith("cat", ["m"]);
    expect(categories.map((c) => c.name)).toEqual(["Canais de texto", "Canais de voz"]);
    const details = await api("GET", `/api/servers/${server.id}`, undefined, owner.token);
    expect(details.body.channels.map((c: { categoryId: string }) => c.categoryId)).toEqual(categories.map((c) => c.id));

    // Members can't organize.
    expect((await api("POST", `/api/servers/${server.id}/categories`, { name: "X" }, members[0].token)).status).toBe(403);

    const sm = await socketFor(members[0].token);
    const created = await api("POST", `/api/servers/${server.id}/categories`, { name: "Jogos" }, owner.token);
    expect(created.status).toBe(201);
    const games = created.body.category.id;
    const a = (await api("POST", `/api/servers/${server.id}/channels`, { name: "lol", categoryId: games }, owner.token)).body.channel;
    const b = (await api("POST", `/api/servers/${server.id}/channels`, { name: "cs", categoryId: games }, owner.token)).body.channel;
    expect((await api("POST", `/api/servers/${server.id}/channels`, { name: "x", categoryId: "nope" }, owner.token)).status).toBe(400);

    // Drag cs above lol, then the category to the top: members see it live.
    const update = next<{ channels: { name: string; categoryId: string }[]; categories: { name: string }[] }>(sm, "channels:update", (p) =>
      p.categories[0]?.name === "Jogos",
    );
    expect((await api("POST", `/api/channels/${b.id}/move`, { categoryId: games, beforeId: a.id }, owner.token)).status).toBe(204);
    expect((await api("POST", `/api/categories/${games}/move`, { beforeId: categories[0].id }, owner.token)).status).toBe(204);
    const live = await update;
    expect(live.categories.map((c) => c.name)).toEqual(["Jogos", "Canais de texto", "Canais de voz"]);
    expect(live.channels.filter((c) => c.categoryId === games).map((c) => c.name)).toEqual(["cs", "lol"]);

    // Moving a channel out to "no category", renaming and deleting the category.
    await api("POST", `/api/channels/${a.id}/move`, { categoryId: null }, owner.token);
    expect((await api("PATCH", `/api/categories/${games}`, { name: "Games" }, owner.token)).body.category.name).toBe("Games");
    expect((await api("DELETE", `/api/categories/${games}`, undefined, owner.token)).status).toBe(204);
    const after = await api("GET", `/api/servers/${server.id}`, undefined, members[0].token);
    expect(after.body.categories.map((c: { name: string }) => c.name)).toEqual(["Canais de texto", "Canais de voz"]);
    expect(after.body.channels.find((c: { name: string }) => c.name === "cs").categoryId).toBeNull();
    sm.close();
  });
});

describe("private channels", () => {
  it("are seen, read and joined only by their roles, the owner and administrators", async () => {
    const { owner, members, server } = await serverWith("priv", ["vip", "comum", "adm"]);
    const [vip, comum, adm] = members;
    const role = (await api("POST", `/api/servers/${server.id}/roles`, { name: "VIP" }, owner.token)).body.role;
    const admRole = (await api("POST", `/api/servers/${server.id}/roles`, { name: "Adm", permissions: Permission.ADMINISTRATOR }, owner.token)).body.role;
    await api("PUT", `/api/servers/${server.id}/members/${vip.user.id}/roles/${role.id}`, undefined, owner.token);
    await api("PUT", `/api/servers/${server.id}/members/${adm.user.id}/roles/${admRole.id}`, undefined, owner.token);

    // @everyone can't be the role a private channel is open to.
    const everyone = (await api("GET", `/api/servers/${server.id}`, undefined, owner.token)).body.roles.find((r: { isDefault: boolean }) => r.isDefault);
    expect((await api("POST", `/api/servers/${server.id}/channels`, { name: "x", private: true, roleIds: [everyone.id] }, owner.token)).status).toBe(400);

    const sc = await socketFor(comum.token);
    let leaked = false;
    sc.on("message:new", () => (leaked = true));
    const leakCheck = (p: { channels: { name: string }[] }) => p.channels.some((c) => c.name === "vip-lounge") && (leaked = true);
    sc.on("channels:update", leakCheck);
    const sv = await socketFor(vip.token);

    const text = (await api("POST", `/api/servers/${server.id}/channels`, { name: "vip lounge", private: true, roleIds: [role.id] }, owner.token)).body.channel;
    const voice = (await api("POST", `/api/servers/${server.id}/channels`, { name: "VIP voz", type: "voice", private: true, roleIds: [role.id] }, owner.token)).body.channel;
    expect(text).toMatchObject({ private: true, roleIds: [role.id] });

    for (const who of [owner, vip, adm]) expect(names(await api("GET", `/api/servers/${server.id}`, undefined, who.token))).toContain("vip-lounge");
    expect(names(await api("GET", `/api/servers/${server.id}`, undefined, comum.token))).not.toContain("vip-lounge");
    expect((await api("GET", `/api/channels/${text.id}/messages`, undefined, comum.token)).status).toBe(404);
    expect((await api("POST", `/api/channels/${text.id}/messages`, { content: "oi" }, comum.token)).status).toBe(404);

    const got = next<{ content: string }>(sv, "message:new");
    expect((await api("POST", `/api/channels/${text.id}/messages`, { content: "só vips" }, owner.token)).status).toBe(201);
    expect((await got).content).toBe("só vips");

    const join = (s: Socket, channelId: string) => new Promise<{ error?: string }>((r) => s.emit("voice:join", { channelId }, r));
    expect((await join(sc, voice.id)).error).toBeTruthy();
    expect((await join(sv, voice.id)).error).toBeUndefined();

    await new Promise((r) => setTimeout(r, 100));
    expect(leaked).toBe(false);

    // Getting the role shows it; losing it hides it again and drops them from its voice channel.
    sc.off("channels:update", leakCheck);
    const shown = next<{ channels: { name: string }[] }>(sc, "channels:update", (p) => p.channels.some((c) => c.name === "vip-lounge"));
    await api("PUT", `/api/servers/${server.id}/members/${comum.user.id}/roles/${role.id}`, undefined, owner.token);
    await shown;
    const kicked = next<{ reason: string }>(sv, "voice:kicked");
    await api("DELETE", `/api/servers/${server.id}/members/${vip.user.id}/roles/${role.id}`, undefined, owner.token);
    expect((await kicked).reason).toMatch(/acesso/);
    expect(names(await api("GET", `/api/servers/${server.id}`, undefined, vip.token))).not.toContain("vip-lounge");

    // Made public again: everyone sees it.
    await api("PATCH", `/api/channels/${text.id}`, { private: false }, owner.token);
    expect(names(await api("GET", `/api/servers/${server.id}`, undefined, vip.token))).toContain("vip-lounge");
    sc.close();
    sv.close();
  });
});

describe("bans", () => {
  it("removes the member, keeps them out until unbanned, and respects the role hierarchy", async () => {
    const { owner, members, server, inviteCode } = await serverWith("ban", ["mod", "alvo"]);
    const [mod, alvo] = members;
    const modRole = (await api("POST", `/api/servers/${server.id}/roles`, { name: "Mod", permissions: Permission.BAN_MEMBERS }, owner.token)).body.role;
    await api("PUT", `/api/servers/${server.id}/members/${mod.user.id}/roles/${modRole.id}`, undefined, owner.token);

    expect((await api("PUT", `/api/servers/${server.id}/bans/${mod.user.id}`, {}, alvo.token)).status).toBe(403);
    expect((await api("PUT", `/api/servers/${server.id}/bans/${owner.user.id}`, {}, mod.token)).status).toBe(403);

    const sa = await socketFor(alvo.token);
    const removed = next<{ reason: string }>(sa, "server:removed");
    expect((await api("PUT", `/api/servers/${server.id}/bans/${alvo.user.id}`, { reason: "spam" }, mod.token)).status).toBe(204);
    expect((await removed).reason).toMatch(/banido.*spam/);
    expect((await api("GET", `/api/servers/${server.id}`, undefined, alvo.token)).status).toBe(404);
    expect((await api("POST", `/api/invites/${inviteCode}`, undefined, alvo.token)).status).toBe(403);

    const list = await api("GET", `/api/servers/${server.id}/bans`, undefined, mod.token);
    expect(list.body.bans).toEqual([expect.objectContaining({ reason: "spam", user: expect.objectContaining({ username: "ban_alvo" }) })]);
    expect((await api("GET", `/api/servers/${server.id}/bans`, undefined, alvo.token)).status).toBe(404);

    expect((await api("DELETE", `/api/servers/${server.id}/bans/${alvo.user.id}`, undefined, mod.token)).status).toBe(204);
    expect((await api("POST", `/api/invites/${inviteCode}`, undefined, alvo.token)).status).toBe(200);
    sa.close();
  });
});

describe("invites", () => {
  it("expire, run out of uses, can be revoked, and the original link can be turned off", async () => {
    const { owner, members, server, inviteCode } = await serverWith("inv", ["m"]);
    const [m] = members;
    const [a, b, c, d] = await Promise.all(["inv_a", "inv_b", "inv_c", "inv_d"].map(register));

    expect((await api("POST", `/api/servers/${server.id}/invites`, { maxAge: 123 }, m.token)).status).toBe(400);
    const once = (await api("POST", `/api/servers/${server.id}/invites`, { maxAge: 3600, maxUses: 1 }, m.token)).body.invite;
    expect(once).toMatchObject({ maxUses: 1, uses: 0 });
    // Asking again with the same settings gives the same (unused) link.
    expect((await api("POST", `/api/servers/${server.id}/invites`, { maxAge: 3600, maxUses: 1 }, m.token)).body.invite.code).toBe(once.code);

    expect((await api("GET", `/api/invites/${once.code}`)).body.expiresAt).toBeGreaterThan(Date.now());
    expect((await api("POST", `/api/invites/${once.code}`, undefined, a.token)).status).toBe(200);
    expect((await api("POST", `/api/invites/${once.code}`, undefined, b.token)).status).toBe(404);
    expect((await api("GET", `/api/invites/${once.code}`)).status).toBe(404);

    // Expired.
    const soon = (await api("POST", `/api/servers/${server.id}/invites`, { maxAge: 1800 }, m.token)).body.invite;
    db.prepare("UPDATE invites SET expires_at = ? WHERE code = ?").run(Date.now() - 1, soon.code);
    expect((await api("POST", `/api/invites/${soon.code}`, undefined, b.token)).status).toBe(404);

    // Only managers list them; the creator (or a manager) revokes.
    const forever = (await api("POST", `/api/servers/${server.id}/invites`, { maxAge: 0 }, m.token)).body.invite;
    expect(forever.expiresAt).toBeNull();
    expect((await api("GET", `/api/servers/${server.id}/invites`, undefined, m.token)).status).toBe(403);
    const list = await api("GET", `/api/servers/${server.id}/invites`, undefined, owner.token);
    expect(list.body.invites.map((i: { code: string }) => i.code)).toEqual([forever.code]);
    expect(list.body.invites[0].creator.username).toBe("inv_m");
    expect((await api("DELETE", `/api/invites/${forever.code}`, undefined, a.token)).status).toBe(403);
    expect((await api("DELETE", `/api/invites/${forever.code}`, undefined, m.token)).status).toBe(204);
    expect((await api("POST", `/api/invites/${forever.code}`, undefined, b.token)).status).toBe(404);

    // The original link works until a manager turns it off.
    expect((await api("POST", `/api/invites/${inviteCode}`, undefined, c.token)).status).toBe(200);
    expect((await api("POST", `/api/servers/${server.id}/invites/reset`, undefined, m.token)).status).toBe(403);
    expect((await api("POST", `/api/servers/${server.id}/invites/reset`, undefined, owner.token)).status).toBe(204);
    expect((await api("POST", `/api/invites/${inviteCode}`, undefined, d.token)).status).toBe(404);
  });
});
