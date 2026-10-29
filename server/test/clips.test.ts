import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { io as connect, type Socket } from "socket.io-client";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { createIceProvider } from "../src/ice.ts";
import { detectClipType } from "../src/media.ts";
import { Permission } from "../../shared/permissions.ts";

const mediaDir = mkdtempSync(path.join(tmpdir(), "voxa-clips-test-"));
const clipsDir = path.join(mediaDir, "clips");
let base = "";
let close: () => Promise<void>;

// Room for two 4 KB clips; a third pushes the oldest out.
const CLIP_SIZE = 4096;
beforeAll(async () => {
  const { http, io } = createApp({ db: openDb(":memory:"), ice: createIceProvider({}), mediaDir, clipsMaxBytes: 2.5 * CLIP_SIZE, maxClipBytes: 3 * CLIP_SIZE });
  await new Promise<void>((r) => http.listen(0, r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  close = () => new Promise((r) => io.close(() => r()));
});
afterAll(() => close());

// Only the headers matter for detection.
const mp4 = (size = CLIP_SIZE, fill = 1) => Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.alloc(size - 12, fill)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84]), Buffer.from("webm"), Buffer.alloc(100)]);

async function api(method: string, p: string, body?: unknown, token?: string) {
  const res = await fetch(base + p, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const postClip = (channelId: string, data: Buffer, token: string, query = "duration=30&width=1280&height=720") =>
  fetch(`${base}/api/channels/${channelId}/clips?${query}`, {
    method: "POST",
    headers: { "content-type": "video/mp4", authorization: `Bearer ${token}` },
    body: new Uint8Array(data),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

let n = 0;
async function user() {
  return (await api("POST", "/api/auth/register", { username: `clip${++n}`, password: "senha-segura" })).body as { token: string; user: { id: string } };
}

describe("detectClipType", () => {
  it("recognizes MP4 and WebM by content", () => {
    expect(detectClipType(mp4())).toBe("mp4");
    expect(detectClipType(WEBM)).toBe("webm");
    expect(detectClipType(Buffer.from("<html><script>alert(1)</script>"))).toBeNull();
    expect(detectClipType(Buffer.alloc(0))).toBeNull();
  });
});

describe("clips in chat", () => {
  it("posts a clip as a message that members receive and can play, and expires the oldest when over budget", async () => {
    const owner = await user();
    const friend = await user();
    const outsider = await user();
    const { server, inviteCode } = (await api("POST", "/api/servers", { name: "Jogadas" }, owner.token)).body;
    await api("POST", `/api/invites/${inviteCode}`, undefined, friend.token);
    const general = (await api("GET", `/api/servers/${server.id}`, undefined, owner.token)).body.channels.find((c: { type: string }) => c.type === "text");

    const socket: Socket = connect(base, { auth: { token: friend.token }, transports: ["websocket"] });
    const received: { event: string; m: { id: string; attachment: { url: string | null } } }[] = [];
    socket.on("message:new", (m) => received.push({ event: "new", m }));
    socket.on("message:update", (m) => received.push({ event: "update", m }));
    await new Promise<void>((r) => socket.on("connect", () => r()));

    const first = await postClip(general.id, mp4(), owner.token, "duration=60&width=1920&height=1080&content=" + encodeURIComponent("que jogada"));
    expect(first.status).toBe(201);
    const m = first.body.message;
    expect(m.content).toBe("que jogada");
    expect(m.attachment).toMatchObject({ kind: "clip", mime: "video/mp4", size: CLIP_SIZE, duration: 60, width: 1920, height: 1080 });
    expect(m.attachment.url).toBe(`/media/clips/${m.id}.mp4`);

    // Served with Range support, so players can seek.
    const ranged = await fetch(base + m.attachment.url, { headers: { range: "bytes=0-99" } });
    expect(ranged.status).toBe(206);
    expect((await ranged.arrayBuffer()).byteLength).toBe(100);

    // Listed with the channel's messages.
    const list = (await api("GET", `/api/channels/${general.id}/messages`, undefined, friend.token)).body.messages;
    expect(list.at(-1).attachment.url).toBe(m.attachment.url);

    // Two more clips go over the 2.5-clip budget: the first one is deleted and its message updated.
    expect((await postClip(general.id, mp4(CLIP_SIZE, 2), friend.token)).status).toBe(201);
    expect((await postClip(general.id, mp4(CLIP_SIZE, 3), owner.token)).status).toBe(201);
    await new Promise((r) => setTimeout(r, 100));
    expect(readdirSync(clipsDir).filter((f) => !f.startsWith("."))).toHaveLength(2);
    expect(existsSync(path.join(clipsDir, `${m.id}.mp4`))).toBe(false);
    expect(received.filter((r) => r.event === "new")).toHaveLength(3);
    const update = received.find((r) => r.event === "update");
    expect(update?.m.id).toBe(m.id);
    expect(update?.m.attachment.url).toBeNull();
    expect((await fetch(base + m.attachment.url)).status).toBe(404);
    socket.close();

    // Not a video, too big, outsiders, bad details: all refused, nothing left behind.
    expect((await postClip(general.id, Buffer.from("<html>oi</html>".padEnd(200)), owner.token)).status).toBe(400);
    expect((await postClip(general.id, mp4(4 * CLIP_SIZE), owner.token)).status).toBe(413);
    expect((await postClip(general.id, mp4(), outsider.token)).status).toBe(404);
    expect((await postClip(general.id, mp4(), owner.token, "duration=abc&width=1280&height=720")).status).toBe(400);
    const voiceChannel = (await api("GET", `/api/servers/${server.id}`, undefined, owner.token)).body.channels.find((c: { type: string }) => c.type === "voice");
    expect((await postClip(voiceChannel.id, mp4(), owner.token)).status).toBe(400);
    expect(readdirSync(clipsDir)).toHaveLength(2);
  });
});

describe("deleting messages", () => {
  it("lets authors delete their own messages, moderators anyone's, and tells everyone", async () => {
    const owner = await user();
    const member = await user();
    const mod = await user();
    const { server, inviteCode } = (await api("POST", "/api/servers", { name: "Apagar" }, owner.token)).body;
    for (const u of [member, mod]) await api("POST", `/api/invites/${inviteCode}`, undefined, u.token);
    const general = (await api("GET", `/api/servers/${server.id}`, undefined, owner.token)).body.channels.find((c: { type: string }) => c.type === "text");
    const say = async (who: { token: string }, content: string) =>
      (await api("POST", `/api/channels/${general.id}/messages`, { content }, who.token)).body.message as { id: string };
    const del = (who: { token: string }, id: string, channelId = general.id) => api("DELETE", `/api/channels/${channelId}/messages/${id}`, undefined, who.token);
    const ids = async () => ((await api("GET", `/api/channels/${general.id}/messages`, undefined, owner.token)).body.messages as { id: string }[]).map((m) => m.id);

    const socket: Socket = connect(base, { auth: { token: owner.token }, transports: ["websocket"] });
    const deleted: string[] = [];
    socket.on("message:delete", (e: { channelId: string; id: string }) => e.channelId === general.id && deleted.push(e.id));
    await new Promise<void>((r) => socket.on("connect", () => r()));

    const mine = await say(member, "ops, mensagem errada");
    const theirs = await say(owner, "mensagem do dono");
    expect((await del(member, mine.id)).status).toBe(204);
    expect((await del(member, theirs.id)).status).toBe(403);
    expect((await del(member, mine.id)).status).toBe(404);

    // "Gerenciar mensagens" lets a moderator delete other people's messages.
    const role = (await api("POST", `/api/servers/${server.id}/roles`, { name: "Mod", permissions: Permission.MANAGE_MESSAGES }, owner.token)).body.role;
    await api("PUT", `/api/servers/${server.id}/members/${mod.user.id}/roles/${role.id}`, undefined, owner.token);
    expect((await del(mod, theirs.id)).status).toBe(204);

    // A clip's video goes with its message.
    const clip = (await postClip(general.id, mp4(1000), member.token)).body.message;
    expect(existsSync(path.join(clipsDir, `${clip.id}.mp4`))).toBe(true);
    expect((await del(member, clip.id)).status).toBe(204);
    expect(existsSync(path.join(clipsDir, `${clip.id}.mp4`))).toBe(false);

    await new Promise((r) => setTimeout(r, 100));
    expect(deleted).toEqual([mine.id, theirs.id, clip.id]);
    const left = await ids();
    expect(left).not.toContain(mine.id);
    expect(left).not.toContain(theirs.id);
    // A message id from another channel is not found through this one.
    const outsider = await user();
    expect((await del(outsider, left[0] ?? "x")).status).toBe(404);
    socket.close();
  });
});
