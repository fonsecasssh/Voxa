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

describe("polls", () => {
  it("are created, voted on, ended by their author, and stay with the message", async () => {
    const dono = await register("pl_dono");
    const membro = await register("pl_membro");
    const fora = await register("pl_fora");
    const { body } = await api("POST", "/api/servers", { name: "Enquetes" }, dono.token);
    await api("POST", `/api/invites/${body.inviteCode}`, undefined, membro.token);
    const geral = body.channels.find((c: { type: string }) => c.type === "text").id;

    // Validation.
    const bad = [
      { question: "", options: ["a", "b"] },
      { question: "Qual?", options: ["só uma"] },
      { question: "Qual?", options: Array.from({ length: 11 }, (_, i) => `o${i}`) },
      { question: "Qual?", options: ["a", "x".repeat(56)] },
      { question: "Qual?", options: ["a", "b"], hours: 5 },
    ];
    for (const poll of bad) expect((await api("POST", `/api/channels/${geral}/messages`, { poll }, dono.token)).status).toBe(400);

    const before = Date.now();
    const sent = await api("POST", `/api/channels/${geral}/messages`, { poll: { question: "Qual mapa?", options: ["Ascent", "Bind", "Haven"], hours: 4 } }, dono.token);
    expect(sent.status).toBe(201);
    const m = sent.body.message;
    expect(m.content).toBe("");
    expect(m.poll).toMatchObject({ question: "Qual mapa?", multi: false, options: [{ text: "Ascent", userIds: [] }, { text: "Bind" }, { text: "Haven" }] });
    expect(m.poll.expiresAt).toBeGreaterThanOrEqual(before + 4 * 3_600_000);

    const vote = (options: unknown, token: string) => api("PUT", `/api/channels/${geral}/messages/${m.id}/poll`, { options }, token);
    expect((await vote([0, 1], membro.token)).status).toBe(400); // only one answer
    expect((await vote([3], membro.token)).status).toBe(400);
    expect((await vote([1], fora.token)).status).toBe(404);
    expect((await vote([1], membro.token)).body.poll.options[1].userIds).toEqual([membro.user.id]);
    // Changing your answer moves the vote.
    const changed = (await vote([2], membro.token)).body.poll;
    expect(changed.options.map((o: { userIds: string[] }) => o.userIds.length)).toEqual([0, 0, 1]);
    await vote([2], dono.token);
    expect((await vote([], dono.token)).body.poll.options[2].userIds).toEqual([membro.user.id]);

    // A reply to it quotes the question; it shows up in the history with the votes.
    const reply = (await api("POST", `/api/channels/${geral}/messages`, { content: "Haven sempre", replyTo: m.id }, membro.token)).body.message;
    expect(reply.replyTo.content).toBe("📊 Qual mapa?");
    const page = (await api("GET", `/api/channels/${geral}/messages`, undefined, membro.token)).body.messages;
    expect(page.find((x: { id: string }) => x.id === m.id).poll.options[2].userIds).toEqual([membro.user.id]);

    // Only its author ends it; then nobody can vote.
    expect((await api("POST", `/api/channels/${geral}/messages/${m.id}/poll/end`, undefined, membro.token)).status).toBe(403);
    const ended = (await api("POST", `/api/channels/${geral}/messages/${m.id}/poll/end`, undefined, dono.token)).body.poll;
    expect(ended.closed).toBe(true);
    expect((await vote([0], membro.token)).status).toBe(400);

    // Multiple choice.
    const multi = (await api("POST", `/api/channels/${geral}/messages`, { poll: { question: "Quais dias?", options: ["Sáb", "Dom"], multi: true, hours: 1 } }, dono.token)).body.message;
    const both = (await api("PUT", `/api/channels/${geral}/messages/${multi.id}/poll`, { options: [0, 1] }, membro.token)).body.poll;
    expect(both.options.map((o: { userIds: string[] }) => o.userIds)).toEqual([[membro.user.id], [membro.user.id]]);
    expect((await api("PUT", `/api/channels/${geral}/messages/${multi.id}/poll`, { options: [0, 0] }, membro.token)).status).toBe(400);
  });
});
