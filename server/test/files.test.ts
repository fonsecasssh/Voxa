import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { io as connect, type Socket } from "socket.io-client";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { createIceProvider } from "../src/ice.ts";

const mediaDir = mkdtempSync(path.join(tmpdir(), "voxa-files-test-"));
const filesDir = path.join(mediaDir, "files");
let base = "";
let close: () => Promise<void>;

// Room for about three 4 KB files; more pushes the oldest out.
beforeAll(async () => {
  const { http, io } = createApp({ db: openDb(":memory:"), ice: createIceProvider({}), mediaDir, filesMaxBytes: 13 * 1024 });
  await new Promise<void>((r) => http.listen(0, r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  close = () => new Promise((r) => io.close(() => r()));
});
afterAll(() => close());

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4000, 1)]);

async function api(method: string, p: string, body?: unknown, token?: string) {
  const res = await fetch(base + p, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const upload = (data: Buffer, name: string, token: string, extra = "") =>
  fetch(`${base}/api/uploads?name=${encodeURIComponent(name)}${extra}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", authorization: `Bearer ${token}` },
    body: new Uint8Array(data),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

let n = 0;
async function user() {
  return (await api("POST", "/api/auth/register", { username: `arq${++n}`, password: "senha-segura" })).body as { token: string; user: { id: string } };
}

describe("files in chat", () => {
  it("uploads files, sends them with a message, serves them safely and cleans up", async () => {
    const owner = await user();
    const friend = await user();
    const { server } = (await api("POST", "/api/servers", { name: "Arquivos" }, owner.token)).body;
    await api("POST", `/api/invites/${server.inviteCode}`, undefined, friend.token);
    const general = (await api("GET", `/api/servers/${server.id}`, undefined, owner.token)).body.channels.find((c: { type: string }) => c.type === "text");
    const send = (body: unknown, token = owner.token) => api("POST", `/api/channels/${general.id}/messages`, body, token);

    const socket: Socket = connect(base, { auth: { token: friend.token }, transports: ["websocket"] });
    const events: { e: string; m: { id: string; files: { id: string; url: string | null }[] } }[] = [];
    socket.on("message:new", (m) => events.push({ e: "new", m }));
    socket.on("message:update", (m) => events.push({ e: "update", m }));
    await new Promise<void>((r) => socket.on("connect", () => r()));

    // Recognized by content: the PNG is an image, the rest are plain files (whatever the name says).
    const img = (await upload(PNG, "print.png", owner.token, "&width=1920&height=1080")).body.upload;
    expect(img).toMatchObject({ kind: "image", mime: "image/png", width: 1920, height: 1080, name: "print.png" });
    const evil = (await upload(Buffer.from("<script>alert(1)</script>"), "../../pagina.html", owner.token)).body.upload;
    expect(evil).toMatchObject({ kind: "file", mime: "application/octet-stream", name: "....pagina.html", width: null });

    // Only files: the message may have no text. Files keep their order.
    const sent = await send({ content: "", uploads: [evil.id, img.id] });
    expect(sent.status).toBe(201);
    expect(sent.body.message.files.map((f: { id: string }) => f.id)).toEqual([evil.id, img.id]);
    await new Promise((r) => setTimeout(r, 50));
    expect(events.find((x) => x.e === "new")?.m.files).toHaveLength(2);
    const listed = (await api("GET", `/api/channels/${general.id}/messages`, undefined, friend.token)).body.messages.at(-1);
    expect(listed.files[1].url).toBe(img.url);

    // Images display inline; anything else downloads, sandboxed.
    const imgRes = await fetch(base + img.url);
    expect(imgRes.headers.get("content-type")).toBe("image/png");
    expect(imgRes.headers.get("content-disposition")).toMatch(/^inline/);
    const evilRes = await fetch(base + evil.url);
    expect(evilRes.headers.get("content-type")).toBe("application/octet-stream");
    expect(evilRes.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(evilRes.headers.get("content-security-policy")).toContain("sandbox");

    // Uploads can't be reused, stolen, or sent in bulk; a message needs text or files.
    expect((await send({ content: "de novo", uploads: [img.id] })).status).toBe(400);
    const mine = (await upload(PNG, "a.png", owner.token)).body.upload;
    expect((await send({ content: "roubei", uploads: [mine.id] }, friend.token)).status).toBe(400);
    expect((await send({ content: "x", uploads: Array(11).fill(mine.id) })).status).toBe(400);
    expect((await send({ content: "" })).status).toBe(400);

    // A file picked by mistake is removed before sending (only by its owner).
    expect((await api("DELETE", `/api/uploads/${mine.id}`, undefined, friend.token)).status).toBe(404);
    expect((await api("DELETE", `/api/uploads/${mine.id}`, undefined, owner.token)).status).toBe(204);
    expect(existsSync(path.join(filesDir, mine.id))).toBe(false);

    // Deleting the message deletes its files.
    expect((await api("DELETE", `/api/channels/${general.id}/messages/${sent.body.message.id}`, undefined, owner.token)).status).toBe(204);
    expect((await fetch(base + img.url)).status).toBe(404);
    expect(existsSync(path.join(filesDir, img.id))).toBe(false);

    // Over the disk budget, the oldest files expire and their message says so.
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const u = (await upload(PNG, `f${i}.png`, owner.token)).body.upload;
      await send({ content: `arquivo ${i}`, uploads: [u.id] });
      ids.push(u.id);
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 100));
    const update = events.find((x) => x.e === "update");
    expect(update?.m.files[0]).toMatchObject({ id: ids[0], url: null });
    expect(existsSync(path.join(filesDir, ids[0]))).toBe(false);
    socket.close();
  });
});
