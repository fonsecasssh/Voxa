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

describe("threads", () => {
  it("start from a message, follow their channel's access, and count their messages", async () => {
    const dono = await register("th_dono");
    const membro = await register("th_membro");
    const outro = await register("th_outro");
    const { body } = await api("POST", "/api/servers", { name: "Topicos" }, dono.token);
    await api("POST", `/api/invites/${body.inviteCode}`, undefined, membro.token);
    await api("POST", `/api/invites/${body.inviteCode}`, undefined, outro.token);
    const s = body.server.id;
    const geral = body.channels.find((c: { type: string }) => c.type === "text").id;
    const voz = body.channels.find((c: { type: string }) => c.type === "voice").id;
    const msg = (await api("POST", `/api/channels/${geral}/messages`, { content: "Quem topa uma ranqueada hoje à noite?" }, dono.token)).body.message;

    expect((await api("POST", `/api/channels/${voz}/threads`, {}, membro.token)).status).toBe(400);
    const thread = (await api("POST", `/api/channels/${geral}/threads`, { messageId: msg.id }, membro.token)).body.channel;
    expect(thread).toMatchObject({ type: "thread", parentId: geral, starterMessageId: msg.id, name: "Quem topa uma ranqueada hoje à noite?" });
    expect((await api("POST", `/api/channels/${geral}/threads`, { messageId: msg.id }, dono.token)).status).toBe(409);

    // Members get it in the channel list; messages go there; the starter shows the count.
    expect((await api("GET", `/api/servers/${s}`, undefined, outro.token)).body.channels.some((c: { id: string }) => c.id === thread.id)).toBe(true);
    await api("POST", `/api/channels/${thread.id}/messages`, { content: "eu!" }, outro.token);
    await api("POST", `/api/channels/${thread.id}/messages`, { content: "bora" }, dono.token);
    const page = (await api("GET", `/api/channels/${geral}/messages`, undefined, membro.token)).body.messages;
    expect(page.find((m: { id: string }) => m.id === msg.id).thread).toMatchObject({ id: thread.id, count: 2 });
    expect((await api("GET", `/api/channels/${thread.id}/messages`, undefined, membro.token)).body.messages.map((m: { content: string }) => m.content)).toEqual(["eu!", "bora"]);

    // Its creator renames it; others (without "Gerenciar mensagens") can't.
    expect((await api("PATCH", `/api/channels/${thread.id}`, { name: "Ranqueada 22h" }, outro.token)).status).toBe(403);
    expect((await api("PATCH", `/api/channels/${thread.id}`, { name: "Ranqueada 22h" }, membro.token)).body.channel.name).toBe("Ranqueada 22h");

    // A thread of a private channel is private too.
    const role = (await api("POST", `/api/servers/${s}/roles`, { name: "Staff" }, dono.token)).body.role;
    const staff = (await api("POST", `/api/servers/${s}/channels`, { name: "staff", private: true, roleIds: [role.id] }, dono.token)).body.channel.id;
    const secret = (await api("POST", `/api/channels/${staff}/threads`, { name: "plano" }, dono.token)).body.channel;
    expect((await api("GET", `/api/channels/${secret.id}/messages`, undefined, membro.token)).status).toBe(404);
    expect((await api("GET", `/api/servers/${s}`, undefined, membro.token)).body.channels.some((c: { id: string }) => c.id === secret.id)).toBe(false);

    // Search finds thread messages; deleting the channel takes its threads along.
    expect((await api("GET", `/api/search?scope=${s}&q=bora`, undefined, membro.token)).body.total).toBe(1);
    expect((await api("DELETE", `/api/channels/${geral}`, undefined, dono.token)).status).toBe(204);
    expect((await api("GET", `/api/channels/${thread.id}/messages`, undefined, dono.token)).status).toBe(404);
  });
});
