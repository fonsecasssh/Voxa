import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { io as connect, type Socket } from "socket.io-client";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { createIceProvider } from "../src/ice.ts";
import { Permission } from "../../shared/permissions.ts";

let base = "";
let close: () => Promise<void>;

beforeAll(async () => {
  const { http, io } = createApp({ db: openDb(":memory:"), ice: createIceProvider({}) });
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

let n = 0;
async function user(name = "u") {
  const r = await api("POST", "/api/auth/register", { username: `${name}${++n}`, password: "senha-segura" });
  return r.body as { token: string; user: { id: string; displayName: string } };
}

function socketFor(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect(base, { auth: { token }, transports: ["websocket"] });
    s.on("connect", () => resolve(s));
    s.on("connect_error", reject);
  });
}
const next = <T>(s: Socket, event: string) => new Promise<T>((r) => s.once(event, r));

/** A server with an owner, a moderator (with a "Mod" role) and a regular member. */
async function setup(modPermissions: number) {
  const owner = await user("dono");
  const mod = await user("mod");
  const member = await user("membro");
  const { body } = await api("POST", "/api/servers", { name: "Cargos" }, owner.token);
  const sid = body.server.id as string;
  expect(body.roles).toEqual([expect.objectContaining({ name: "@everyone", isDefault: true, position: 0 })]);
  await api("POST", `/api/invites/${body.inviteCode}`, undefined, mod.token);
  await api("POST", `/api/invites/${body.inviteCode}`, undefined, member.token);
  const modRole = (await api("POST", `/api/servers/${sid}/roles`, { name: "Mod", color: "#E91E63", permissions: modPermissions, hoist: true }, owner.token)).body.role;
  expect((await api("PUT", `/api/servers/${sid}/members/${mod.user.id}/roles/${modRole.id}`, undefined, owner.token)).status).toBe(200);
  return { owner, mod, member, sid, modRole, textChannel: body.channels[0], voiceChannel: body.channels[1] };
}

describe("profile", () => {
  it("changes the display name and tells everyone who can see it", async () => {
    const a = await user("perfil");
    const b = await user("amigo");
    await api("POST", "/api/friends", { username: `amigo${n}` }, a.token);
    await api("POST", `/api/friends/${a.user.id}/accept`, undefined, b.token);
    const sb = await socketFor(b.token);
    const updated = next<{ id: string; displayName: string }>(sb, "user:update");
    expect((await api("PATCH", "/api/me", { displayName: "Novo Nome" }, a.token)).body.user.displayName).toBe("Novo Nome");
    expect(await updated).toMatchObject({ id: a.user.id, displayName: "Novo Nome" });
    expect((await api("GET", "/api/me", undefined, a.token)).body.user.displayName).toBe("Novo Nome");
    expect((await api("PATCH", "/api/me", { displayName: "" }, a.token)).status).toBe(400);
    sb.close();
  });

  it("changes the password and signs out other sessions", async () => {
    const a = await user("senha");
    const other = await api("POST", "/api/auth/login", { username: `senha${n}`, password: "senha-segura" });
    expect((await api("POST", "/api/me/password", { currentPassword: "errada", newPassword: "nova-senha-123" }, a.token)).status).toBe(400);
    expect((await api("POST", "/api/me/password", { currentPassword: "senha-segura", newPassword: "nova-senha-123" }, a.token)).status).toBe(204);
    expect((await api("GET", "/api/me", undefined, a.token)).status).toBe(200); // this session stays
    expect((await api("GET", "/api/me", undefined, other.body.token)).status).toBe(401); // others are signed out
    expect((await api("POST", "/api/auth/login", { username: `senha${n}`, password: "nova-senha-123" })).status).toBe(200);
  });
});

describe("roles and permissions", () => {
  it("exposes roles and member data with the server", async () => {
    const { owner, mod, sid, modRole } = await setup(Permission.KICK_MEMBERS);
    const d = (await api("GET", `/api/servers/${sid}`, undefined, owner.token)).body;
    expect(d.roles.map((r: { name: string }) => r.name)).toEqual(["Mod", "@everyone"]);
    expect(d.roles[0]).toMatchObject({ color: "#e91e63", hoist: true, position: 1 });
    expect(d.memberData[mod.user.id]).toEqual({ nickname: null, roleIds: [modRole.id] });
  });

  it("only lets permitted members manage roles, below their own", async () => {
    const { owner, mod, member, sid, modRole } = await setup(Permission.MANAGE_ROLES);
    // A regular member can't create roles.
    expect((await api("POST", `/api/servers/${sid}/roles`, { name: "X" }, member.token)).status).toBe(403);
    // The mod can create a role, which lands below theirs...
    const helper = (await api("POST", `/api/servers/${sid}/roles`, { name: "Ajudante" }, mod.token)).body.role;
    expect(helper.position).toBe(1);
    // ...but can't edit or delete their own role, or move a role above it.
    expect((await api("PATCH", `/api/servers/${sid}/roles/${modRole.id}`, { name: "Chefe" }, mod.token)).status).toBe(403);
    expect((await api("DELETE", `/api/servers/${sid}/roles/${modRole.id}`, undefined, mod.token)).status).toBe(403);
    expect((await api("POST", `/api/servers/${sid}/roles/${helper.id}/move`, { direction: "up" }, mod.token)).status).toBe(403);
    // Can't grant permissions they don't have.
    expect((await api("PATCH", `/api/servers/${sid}/roles/${helper.id}`, { permissions: Permission.ADMINISTRATOR }, mod.token)).status).toBe(403);
    expect((await api("PATCH", `/api/servers/${sid}/roles/${helper.id}`, { permissions: Permission.MANAGE_ROLES, color: "#00ff00" }, mod.token)).status).toBe(200);
    // Can assign the lower role, not their own.
    expect((await api("PUT", `/api/servers/${sid}/members/${member.user.id}/roles/${helper.id}`, undefined, mod.token)).status).toBe(200);
    expect((await api("PUT", `/api/servers/${sid}/members/${member.user.id}/roles/${modRole.id}`, undefined, mod.token)).status).toBe(403);
    // The owner can reorder freely.
    const moved = await api("POST", `/api/servers/${sid}/roles/${helper.id}/move`, { direction: "up" }, owner.token);
    expect(moved.body.roles.map((r: { name: string }) => r.name)).toEqual(["Ajudante", "Mod", "@everyone"]);
    // @everyone can't be deleted or renamed, but its permissions can change.
    const everyone = moved.body.roles[2];
    expect((await api("DELETE", `/api/servers/${sid}/roles/${everyone.id}`, undefined, owner.token)).status).toBe(400);
    expect((await api("PATCH", `/api/servers/${sid}/roles/${everyone.id}`, { name: "todos" }, owner.token)).status).toBe(400);
    expect((await api("PATCH", `/api/servers/${sid}/roles/${everyone.id}`, { permissions: 0 }, owner.token)).status).toBe(200);
  });

  it("administrators can do everything except act above their role", async () => {
    const { owner, mod, member, sid } = await setup(Permission.ADMINISTRATOR);
    expect((await api("PATCH", `/api/servers/${sid}`, { name: "Renomeado" }, mod.token)).status).toBe(200);
    expect((await api("DELETE", `/api/servers/${sid}/members/${member.user.id}`, undefined, mod.token)).status).toBe(204);
    expect((await api("DELETE", `/api/servers/${sid}/members/${owner.user.id}`, undefined, mod.token)).status).toBe(403);
    // Only the owner deletes the server.
    expect((await api("DELETE", `/api/servers/${sid}`, undefined, mod.token)).status).toBe(403);
  });

  it("broadcasts role and member changes live", async () => {
    const { owner, member, sid } = await setup(0);
    const sm = await socketFor(member.token);
    const rolesUpdate = next<{ roles: { name: string }[] }>(sm, "roles:update");
    const vip = (await api("POST", `/api/servers/${sid}/roles`, { name: "VIP", color: "#f1c40f" }, owner.token)).body.role;
    expect((await rolesUpdate).roles.map((r) => r.name)).toContain("VIP");
    const memberUpdate = next<{ userId: string; roleIds: string[] }>(sm, "member:update");
    await api("PUT", `/api/servers/${sid}/members/${member.user.id}/roles/${vip.id}`, undefined, owner.token);
    expect(await memberUpdate).toMatchObject({ userId: member.user.id, roleIds: [vip.id] });
    // Deleting a role removes it from members.
    await api("DELETE", `/api/servers/${sid}/roles/${vip.id}`, undefined, owner.token);
    const d = (await api("GET", `/api/servers/${sid}`, undefined, owner.token)).body;
    expect(d.memberData[member.user.id].roleIds).toEqual([]);
    sm.close();
  });
});

describe("nicknames", () => {
  it("follows CHANGE_NICKNAME / MANAGE_NICKNAMES and the hierarchy", async () => {
    const { owner, mod, member, sid } = await setup(Permission.MANAGE_NICKNAMES);
    // Members may change their own nickname (default @everyone permission).
    expect((await api("PATCH", `/api/servers/${sid}/members/${member.user.id}`, { nickname: "Membrinho" }, member.token)).body.nickname).toBe("Membrinho");
    // ...but not someone else's.
    expect((await api("PATCH", `/api/servers/${sid}/members/${mod.user.id}`, { nickname: "x" }, member.token)).status).toBe(403);
    // The mod can rename the member, not the owner.
    expect((await api("PATCH", `/api/servers/${sid}/members/${member.user.id}`, { nickname: "Renomeado" }, mod.token)).status).toBe(200);
    expect((await api("PATCH", `/api/servers/${sid}/members/${owner.user.id}`, { nickname: "x" }, mod.token)).status).toBe(403);
    // An empty nickname resets it.
    expect((await api("PATCH", `/api/servers/${sid}/members/${member.user.id}`, { nickname: "" }, member.token)).body.nickname).toBeNull();
    // Without CHANGE_NICKNAME on @everyone, members can't change their own.
    const everyone = (await api("GET", `/api/servers/${sid}`, undefined, owner.token)).body.roles.at(-1);
    await api("PATCH", `/api/servers/${sid}/roles/${everyone.id}`, { permissions: 0 }, owner.token);
    expect((await api("PATCH", `/api/servers/${sid}/members/${member.user.id}`, { nickname: "y" }, member.token)).status).toBe(403);
  });
});

describe("kick, leave and server management", () => {
  it("kicks a member out of the server and its voice channel", async () => {
    const { owner, mod, member, sid, voiceChannel } = await setup(Permission.KICK_MEMBERS);
    const sm = await socketFor(member.token);
    const joined = await new Promise<{ error?: string }>((r) => sm.emit("voice:join", { channelId: voiceChannel.id }, r));
    expect(joined.error).toBeUndefined();

    const removed = next<{ serverId: string; reason: string }>(sm, "server:removed");
    const kicked = next<{ reason: string }>(sm, "voice:kicked");
    expect((await api("DELETE", `/api/servers/${sid}/members/${member.user.id}`, undefined, member.token)).status).toBe(403);
    expect((await api("DELETE", `/api/servers/${sid}/members/${member.user.id}`, undefined, mod.token)).status).toBe(204);
    expect((await removed).serverId).toBe(sid);
    expect((await kicked).reason).toMatch(/removido/);
    // No longer a member: no access, and their socket stopped getting the server's events.
    expect((await api("GET", `/api/servers/${sid}`, undefined, member.token)).status).toBe(404);
    let leaked = false;
    sm.on("channel:new", () => (leaked = true));
    await api("POST", `/api/servers/${sid}/channels`, { name: "secreto" }, owner.token);
    await new Promise((r) => setTimeout(r, 100));
    expect(leaked).toBe(false);
    sm.close();
  });

  it("lets members leave, but not the owner; only the owner deletes", async () => {
    const { owner, member, sid } = await setup(0);
    expect((await api("POST", `/api/servers/${sid}/leave`, undefined, owner.token)).status).toBe(400);
    expect((await api("POST", `/api/servers/${sid}/leave`, undefined, member.token)).status).toBe(204);
    expect((await api("GET", "/api/me", undefined, member.token)).body.servers).toEqual([]);
    const so = await socketFor(owner.token);
    const removed = next<{ serverId: string }>(so, "server:removed");
    expect((await api("DELETE", `/api/servers/${sid}`, undefined, owner.token)).status).toBe(204);
    expect((await removed).serverId).toBe(sid);
    expect((await api("GET", `/api/servers/${sid}`, undefined, owner.token)).status).toBe(404);
    so.close();
  });

  it("manages channels with MANAGE_CHANNELS", async () => {
    const { mod, member, sid, textChannel, voiceChannel } = await setup(Permission.MANAGE_CHANNELS);
    expect((await api("POST", `/api/servers/${sid}/channels`, { name: "x" }, member.token)).status).toBe(403);
    expect((await api("PATCH", `/api/channels/${textChannel.id}`, { name: "Bate Papo" }, member.token)).status).toBe(403);
    const renamed = await api("PATCH", `/api/channels/${textChannel.id}`, { name: "Bate Papo" }, mod.token);
    expect(renamed.body.channel.name).toBe("bate-papo");
    expect((await api("PATCH", `/api/channels/${voiceChannel.id}`, { name: "Sala de Jogos" }, mod.token)).body.channel.name).toBe("Sala de Jogos");
    expect((await api("DELETE", `/api/channels/${voiceChannel.id}`, undefined, mod.token)).status).toBe(204);
    const d = (await api("GET", `/api/servers/${sid}`, undefined, mod.token)).body;
    expect(d.channels.map((c: { name: string }) => c.name)).toEqual(["bate-papo"]);
  });
});
