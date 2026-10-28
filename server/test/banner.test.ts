import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { io as connect, type Socket } from "socket.io-client";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { createIceProvider } from "../src/ice.ts";
import { detectImageType } from "../src/media.ts";
import { Permission } from "../../shared/permissions.ts";

const mediaDir = mkdtempSync(path.join(tmpdir(), "voxa-media-test-"));
const bannersDir = path.join(mediaDir, "banners");
let base = "";
let close: () => Promise<void>;

beforeAll(async () => {
  const { http, io } = createApp({ db: openDb(":memory:"), ice: createIceProvider({}), mediaDir });
  await new Promise<void>((r) => http.listen(0, r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  close = () => new Promise((r) => io.close(() => r()));
});
afterAll(() => close());

// Smallest valid files of each kind (only the header matters for detection).
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(64, 2)]);

async function api(method: string, p: string, body?: unknown, token?: string) {
  const res = await fetch(base + p, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const upload = (sid: string, data: Buffer, token: string, type = "image/webp") =>
  fetch(`${base}/api/servers/${sid}/banner`, { method: "PUT", headers: { "content-type": type, authorization: `Bearer ${token}` }, body: new Uint8Array(data) }).then(
    async (r) => ({ status: r.status, body: await r.json() }),
  );

let n = 0;
async function user() {
  return (await api("POST", "/api/auth/register", { username: `banner${++n}`, password: "senha-segura" })).body as { token: string; user: { id: string } };
}

describe("detectImageType", () => {
  it("recognizes images by content, not by name or header", () => {
    expect(detectImageType(PNG)).toBe("png");
    expect(detectImageType(WEBP)).toBe("webp");
    expect(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpg");
    expect(detectImageType(Buffer.from("GIF89a....."))).toBe("gif");
    expect(detectImageType(Buffer.from("<svg onload=alert(1)>"))).toBeNull();
    expect(detectImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe("server banner", () => {
  it("uploads, serves, replaces and removes the banner", async () => {
    const owner = await user();
    const member = await user();
    const { body } = await api("POST", "/api/servers", { name: "Com banner" }, owner.token);
    const sid = body.server.id;
    expect(body.server.banner).toBeNull();
    await api("POST", `/api/invites/${body.server.inviteCode}`, undefined, member.token);

    // Members without "Gerenciar servidor" can't change it; non-images are refused.
    expect((await upload(sid, WEBP, member.token)).status).toBe(403);
    expect((await upload(sid, Buffer.from("<html>"), owner.token, "image/png")).status).toBe(400);
    expect((await upload(sid, Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024, 7)]), owner.token, "image/png")).status).toBe(413);

    const sm: Socket = await new Promise((resolve) => {
      const s = connect(base, { auth: { token: member.token }, transports: ["websocket"] });
      s.on("connect", () => resolve(s));
    });
    const live = new Promise<{ banner: string }>((r) => sm.once("server:update", r));
    const first = await upload(sid, WEBP, owner.token);
    expect(first.status).toBe(200);
    expect(first.body.server.banner).toMatch(new RegExp(`^/media/banners/${sid}-[0-9a-f]{16}\\.webp$`));
    expect((await live).banner).toBe(first.body.server.banner);

    // Served publicly with long caching; listed with the server and on the invite page.
    const img = await fetch(base + first.body.server.banner);
    expect(img.status).toBe(200);
    expect(img.headers.get("cache-control")).toMatch(/immutable/);
    expect(Buffer.from(await img.arrayBuffer()).equals(WEBP)).toBe(true);
    expect((await api("GET", "/api/me", undefined, member.token)).body.servers[0].banner).toBe(first.body.server.banner);
    expect((await api("GET", `/api/invites/${body.server.inviteCode}`)).body.server.banner).toBe(first.body.server.banner);

    // Replacing removes the old file.
    const second = await upload(sid, PNG, owner.token, "image/png");
    expect(second.body.server.banner).toMatch(/\.png$/);
    expect(readdirSync(bannersDir).filter((f) => f.startsWith(sid))).toEqual([path.basename(second.body.server.banner)]);

    // A member given "Gerenciar servidor" may remove it.
    const role = (await api("POST", `/api/servers/${sid}/roles`, { name: "Gerente", permissions: Permission.MANAGE_SERVER }, owner.token)).body.role;
    await api("PUT", `/api/servers/${sid}/members/${member.user.id}/roles/${role.id}`, undefined, owner.token);
    const removed = await api("DELETE", `/api/servers/${sid}/banner`, undefined, member.token);
    expect(removed.body.server.banner).toBeNull();
    expect(existsSync(path.join(bannersDir, path.basename(second.body.server.banner)))).toBe(false);
    expect((await fetch(base + second.body.server.banner)).status).toBe(404);
    sm.close();
  });

  it("handles the server icon the same way, independently of the banner", async () => {
    const owner = await user();
    const member = await user();
    const { body } = await api("POST", "/api/servers", { name: "Com ícone" }, owner.token);
    const sid = body.server.id;
    expect(body.server.icon).toBeNull();
    await api("POST", `/api/invites/${body.server.inviteCode}`, undefined, member.token);
    const uploadIcon = (data: Buffer, token: string) =>
      fetch(`${base}/api/servers/${sid}/icon`, { method: "PUT", headers: { "content-type": "image/webp", authorization: `Bearer ${token}` }, body: new Uint8Array(data) }).then(
        async (r) => ({ status: r.status, body: await r.json() }),
      );

    expect((await uploadIcon(WEBP, member.token)).status).toBe(403);
    expect((await uploadIcon(Buffer.from("nope"), owner.token)).status).toBe(400);
    const banner = (await upload(sid, PNG, owner.token, "image/png")).body.server.banner;
    const icon = (await uploadIcon(WEBP, owner.token)).body.server;
    expect(icon.icon).toMatch(new RegExp(`^/media/icons/${sid}-[0-9a-f]{16}\\.webp$`));
    expect(icon.banner).toBe(banner); // the banner is untouched
    expect((await fetch(base + icon.icon)).status).toBe(200);
    expect((await api("GET", `/api/invites/${body.server.inviteCode}`)).body.server.icon).toBe(icon.icon);

    const removed = (await api("DELETE", `/api/servers/${sid}/icon`, undefined, owner.token)).body.server;
    expect(removed.icon).toBeNull();
    expect(removed.banner).toBe(banner);
    expect(existsSync(path.join(mediaDir, "icons", path.basename(icon.icon)))).toBe(false);
  });

  it("sets the profile picture and banner, shown wherever the user appears", async () => {
    const me = await user();
    const friend = await user();
    const { body } = await api("POST", "/api/servers", { name: "Perfis" }, me.token);
    await api("POST", `/api/invites/${body.server.inviteCode}`, undefined, friend.token);
    const channelId = body.channels[0].id;
    await api("POST", `/api/channels/${channelId}/messages`, { content: "oi" }, me.token);

    const fsock: Socket = await new Promise((resolve) => {
      const s = connect(base, { auth: { token: friend.token }, transports: ["websocket"] });
      s.on("connect", () => resolve(s));
    });
    const put = (p: string, data: Buffer) =>
      fetch(`${base}${p}`, { method: "PUT", headers: { "content-type": "image/webp", authorization: `Bearer ${me.token}` }, body: new Uint8Array(data) }).then(
        async (r) => ({ status: r.status, body: await r.json() }),
      );

    expect((await put("/api/me/avatar", Buffer.from("not an image"))).status).toBe(400);
    const live = new Promise<{ avatar: string }>((r) => fsock.once("user:update", r));
    const avatar = (await put("/api/me/avatar", WEBP)).body.user.avatar;
    expect(avatar).toMatch(new RegExp(`^/media/avatars/${me.user.id}-[0-9a-f]{16}\\.webp$`));
    expect((await live).avatar).toBe(avatar);
    const banner = (await put("/api/me/banner", PNG)).body.user.banner;
    expect(banner).toMatch(/^\/media\/profile-banners\/.+\.png$/);
    expect((await fetch(base + avatar)).status).toBe(200);

    // Everywhere the user shows up: /api/me, member list, message authors.
    expect((await api("GET", "/api/me", undefined, me.token)).body.user).toMatchObject({ avatar, banner });
    const members = (await api("GET", `/api/servers/${body.server.id}`, undefined, friend.token)).body.members;
    expect(members.find((m: { id: string }) => m.id === me.user.id)).toMatchObject({ avatar, banner });
    const msgs = (await api("GET", `/api/channels/${channelId}/messages`, undefined, friend.token)).body.messages;
    expect(msgs[0].author).toMatchObject({ avatar });

    // Removing deletes the file and clears it everywhere.
    expect((await api("DELETE", "/api/me/avatar", undefined, me.token)).body.user.avatar).toBeNull();
    expect(existsSync(path.join(mediaDir, "avatars", path.basename(avatar)))).toBe(false);
    expect((await api("GET", "/api/me", undefined, me.token)).body.user.banner).toBe(banner);
    fsock.close();
  });

  it("deletes the image files with the server, and refuses path tricks", async () => {
    const owner = await user();
    const sid = (await api("POST", "/api/servers", { name: "Temporário" }, owner.token)).body.server.id;
    const file = path.basename((await upload(sid, WEBP, owner.token)).body.server.banner);
    const iconRes = await fetch(`${base}/api/servers/${sid}/icon`, {
      method: "PUT",
      headers: { "content-type": "image/png", authorization: `Bearer ${owner.token}` },
      body: new Uint8Array(PNG),
    });
    const iconFile = path.basename((await iconRes.json()).server.icon);
    await api("DELETE", `/api/servers/${sid}`, undefined, owner.token);
    expect(existsSync(path.join(bannersDir, file))).toBe(false);
    expect(existsSync(path.join(mediaDir, "icons", iconFile))).toBe(false);
    expect((await fetch(`${base}/media/banners/..%2F..%2Fetc%2Fpasswd`)).status).toBeGreaterThanOrEqual(400);
  });
});

describe("animated GIFs", () => {
  it("accepts GIFs up to 8 MB as profile picture and server icon, but still caps other images at 2 MB", async () => {
    const owner = await user();
    const { body } = await api("POST", "/api/servers", { name: "Animado" }, owner.token);
    const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(3 * 1024 * 1024, 7)]);
    const bigPng = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024, 7)]);
    const put = (p: string, data: Buffer, type: string) =>
      fetch(base + p, { method: "PUT", headers: { "content-type": type, authorization: `Bearer ${owner.token}` }, body: new Uint8Array(data) }).then(async (r) => ({
        status: r.status,
        body: await r.json(),
      }));

    const avatar = await put("/api/me/avatar", gif, "image/gif");
    expect(avatar.status).toBe(200);
    expect(avatar.body.user.avatar).toMatch(/^\/media\/avatars\/.+\.gif$/);
    const icon = await put(`/api/servers/${body.server.id}/icon`, gif, "image/gif");
    expect(icon.status).toBe(200);
    expect(icon.body.server.icon).toMatch(/\.gif$/);
    const served = await fetch(base + avatar.body.user.avatar);
    expect(served.headers.get("content-type")).toBe("image/gif");

    expect((await put("/api/me/avatar", bigPng, "image/png")).status).toBe(413);
    expect((await put("/api/me/avatar", Buffer.concat([gif, Buffer.alloc(6 * 1024 * 1024)]), "image/gif")).status).toBe(413);
  });
});
