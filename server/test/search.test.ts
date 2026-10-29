import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
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
const register = async (u: string) => (await api("POST", "/api/auth/register", { username: u, password: "senha-segura" })).body as { token: string; user: { id: string } };
const contents = (r: { body: { messages: { content: string }[] } }) => r.body.messages.map((m) => m.content);

describe("message search", () => {
  it("finds words (accents ignored, prefix on the last), with filters, only where you can read", async () => {
    const ana = await register("busca_ana");
    const beto = await register("busca_beto");
    const { body } = await api("POST", "/api/servers", { name: "Busca" }, ana.token);
    await api("POST", `/api/invites/${body.inviteCode}`, undefined, beto.token);
    const geral = body.channels.find((c: { type: string }) => c.type === "text");
    const role = (await api("POST", `/api/servers/${body.server.id}/roles`, { name: "VIP" }, ana.token)).body.role;
    const vip = (await api("POST", `/api/servers/${body.server.id}/channels`, { name: "vip", private: true, roleIds: [role.id] }, ana.token)).body.channel;
    const s = body.server.id;
    const post = (ch: string, content: string, token = ana.token) => api("POST", `/api/channels/${ch}/messages`, { content }, token);
    await post(geral.id, "Bora jogar Valorant à noite?");
    await post(geral.id, "A ação foi rápida demais", beto.token);
    await post(geral.id, "olha https://exemplo.com/valorant");
    await post(vip.id, "segredo do valorant");
    const search = (q: string, token = beto.token, scope = s) => api("GET", `/api/search?scope=${scope}&q=${encodeURIComponent(q)}`, undefined, token);

    expect(contents(await search("valorant"))).toEqual(["olha https://exemplo.com/valorant", "Bora jogar Valorant à noite?"]);
    expect(contents(await search("valorant", ana.token))).toHaveLength(3); // she sees #vip
    expect(contents(await search("acao"))).toEqual(["A ação foi rápida demais"]);
    expect(contents(await search("rapi"))).toEqual(["A ação foi rápida demais"]);
    expect(contents(await search("de:busca_beto"))).toEqual(["A ação foi rápida demais"]);
    expect(contents(await search("valorant de:@busca_ana tem:link"))).toEqual(["olha https://exemplo.com/valorant"]);
    expect(contents(await search("valorant em:#vip", ana.token))).toEqual(["segredo do valorant"]);
    expect(contents(await search("valorant de:ninguem"))).toEqual([]);
    // FTS syntax in the query is just text.
    expect((await search('"valorant" OR NEAR(x')).status).toBe(200);
    expect((await search("")).body).toEqual({ messages: [], total: 0 });
    // Edits and deletions are reflected.
    const msg = (await post(geral.id, "palavraunica")).body.message;
    await api("PATCH", `/api/channels/${geral.id}/messages/${msg.id}`, { content: "outracoisa" }, ana.token);
    expect(contents(await search("palavraunica"))).toEqual([]);
    expect(contents(await search("outracoisa"))).toEqual(["outracoisa"]);
    await api("DELETE", `/api/channels/${geral.id}/messages/${msg.id}`, undefined, ana.token);
    expect(contents(await search("outracoisa"))).toEqual([]);
    // Not a member: nothing.
    const x = await register("busca_x");
    expect((await search("valorant", x.token)).status).toBe(404);
  });

  it("loads the messages around one, to jump to it", async () => {
    const a = await register("perto_a");
    const { body } = await api("POST", "/api/servers", { name: "Perto" }, a.token);
    const ch = body.channels.find((c: { type: string }) => c.type === "text").id;
    const ids: string[] = [];
    for (let i = 0; i < 80; i++) ids.push((await api("POST", `/api/channels/${ch}/messages`, { content: `m${i}` }, a.token)).body.message.id);
    const r = await api("GET", `/api/channels/${ch}/messages/around/${ids[10]}`, undefined, a.token);
    expect(r.body.messages.map((m: { content: string }) => m.content)).toEqual(Array.from({ length: 36 }, (_, i) => `m${i}`));
    expect(r.body.hasNewer).toBe(true);
    const end = await api("GET", `/api/channels/${ch}/messages/around/${ids[78]}`, undefined, a.token);
    expect(end.body.hasNewer).toBe(false);
    expect(end.body.messages.at(-1).content).toBe("m79");
  });
});

describe("pinned messages", () => {
  it("lets moderators (or anyone in a DM) pin, lists them, and tells everyone", async () => {
    const dono = await register("pin_dono");
    const membro = await register("pin_membro");
    const { body } = await api("POST", "/api/servers", { name: "Pins" }, dono.token);
    await api("POST", `/api/invites/${body.inviteCode}`, undefined, membro.token);
    const ch = body.channels.find((c: { type: string }) => c.type === "text").id;
    const m = (await api("POST", `/api/channels/${ch}/messages`, { content: "regras do servidor" }, membro.token)).body.message;
    expect(m.pinnedAt).toBeNull();
    expect((await api("PUT", `/api/channels/${ch}/pins/${m.id}`, undefined, membro.token)).status).toBe(403);
    const pinned = await api("PUT", `/api/channels/${ch}/pins/${m.id}`, undefined, dono.token);
    expect(pinned.body.message.pinnedAt).toBeGreaterThan(0);
    expect((await api("GET", `/api/channels/${ch}/pins`, undefined, membro.token)).body.messages.map((x: { content: string }) => x.content)).toEqual(["regras do servidor"]);
    await api("DELETE", `/api/channels/${ch}/pins/${m.id}`, undefined, dono.token);
    expect((await api("GET", `/api/channels/${ch}/pins`, undefined, membro.token)).body.messages).toEqual([]);

    // DMs: either person.
    await api("POST", "/api/friends", { username: "pin_membro" }, dono.token);
    await api("POST", `/api/friends/${dono.user.id}/accept`, undefined, membro.token);
    const dm = (await api("POST", "/api/dms", { userId: membro.user.id }, dono.token)).body.dm.channel.id;
    const d = (await api("POST", `/api/channels/${dm}/messages`, { content: "endereço da festa" }, dono.token)).body.message;
    expect((await api("PUT", `/api/channels/${dm}/pins/${d.id}`, undefined, membro.token)).status).toBe(200);
    // Not your channel: 404.
    const x = await register("pin_x");
    expect((await api("GET", `/api/channels/${dm}/pins`, undefined, x.token)).status).toBe(404);
  });
});
