import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { Permission } from "../../shared/permissions.ts";

let base = "";
let close: () => Promise<void>;
beforeAll(async () => {
  const { http, io } = createApp({ db: openDb(":memory:") });
  await new Promise<void>((r) => http.listen(0, r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  close = () => new Promise((r) => io.close(() => r()));
});
afterAll(() => close());

async function api(method: string, path: string, body?: unknown, token?: string, raw?: Buffer) {
  const res = await fetch(base + path, {
    method,
    redirect: "manual",
    headers: { ...(raw ? { "content-type": "application/octet-stream" } : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: raw ? new Uint8Array(raw) : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, location: res.headers.get("location"), body: text && text.startsWith("{") ? JSON.parse(text) : null };
}
const register = async (u: string) => (await api("POST", "/api/auth/register", { username: u, password: "senha-segura" })).body as { token: string; user: { id: string } };
// The smallest valid PNG and GIF.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

describe("custom emojis", () => {
  it("are managed with the permission, usable in reactions, and served by id", async () => {
    const dono = await register("emo_dono");
    const membro = await register("emo_membro");
    const { body } = await api("POST", "/api/servers", { name: "Emo" }, dono.token);
    await api("POST", `/api/invites/${body.inviteCode}`, undefined, membro.token);
    const s = body.server.id;
    const ch = body.channels.find((c: { type: string }) => c.type === "text").id;

    expect((await api("POST", `/api/servers/${s}/emojis?name=kekw`, undefined, membro.token, PNG)).status).toBe(403);
    expect((await api("POST", `/api/servers/${s}/emojis?name=a b`, undefined, dono.token, PNG)).status).toBe(400);
    expect((await api("POST", `/api/servers/${s}/emojis?name=texto`, undefined, dono.token, Buffer.from("não é imagem"))).status).toBe(400);
    const kekw = (await api("POST", `/api/servers/${s}/emojis?name=kekw`, undefined, dono.token, PNG)).body.emoji;
    expect(kekw).toMatchObject({ name: "kekw", animated: false, url: `/api/emojis/${kekw.id}/image` });
    expect((await api("POST", `/api/servers/${s}/emojis?name=KEKW`, undefined, dono.token, PNG)).status).toBe(409);
    const party = (await api("POST", `/api/servers/${s}/emojis?name=party`, undefined, dono.token, GIF)).body.emoji;
    expect(party.animated).toBe(true);

    // A role with the permission can manage them too.
    const role = (await api("POST", `/api/servers/${s}/roles`, { name: "Emojis", permissions: Permission.MANAGE_EMOJIS }, dono.token)).body.role;
    await api("PUT", `/api/servers/${s}/members/${membro.user.id}/roles/${role.id}`, undefined, dono.token);
    expect((await api("PATCH", `/api/emojis/${kekw.id}`, { name: "risada" }, membro.token)).body.emoji.name).toBe("risada");

    // The picture is public, by id.
    const img = await api("GET", `/api/emojis/${kekw.id}/image`);
    expect(img.status).toBe(302);
    const file = await fetch(base + img.location!);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await file.arrayBuffer()).equals(PNG)).toBe(true);

    // Everyone in the server gets the list; reactions accept existing ones only.
    expect((await api("GET", "/api/me/emojis", undefined, membro.token)).body.emojis.map((e: { name: string }) => e.name)).toEqual(["risada", "party"]);
    const msg = (await api("POST", `/api/channels/${ch}/messages`, { content: "<:risada:" + kekw.id + "> kkk" }, membro.token)).body.message;
    const token = `<:risada:${kekw.id}>`;
    expect((await api("PUT", `/api/channels/${ch}/messages/${msg.id}/reactions/${encodeURIComponent(token)}`, undefined, dono.token)).status).toBe(204);
    expect((await api("PUT", `/api/channels/${ch}/messages/${msg.id}/reactions/${encodeURIComponent("<:fake:00000000-0000-0000-0000-000000000000>")}`, undefined, dono.token)).status).toBe(400);

    expect((await api("DELETE", `/api/emojis/${kekw.id}`, undefined, membro.token)).status).toBe(204);
    expect((await api("GET", `/api/emojis/${kekw.id}/image`)).status).toBe(404);
  });
});
