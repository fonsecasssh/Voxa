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

describe("profile", () => {
  it("saves a bio and a profile color, shows them to others, and validates them", async () => {
    const ana = await register("pf_ana");
    const bia = await register("pf_bia");
    expect((await api("PATCH", "/api/me", { color: "vermelho" }, ana.token)).status).toBe(400);
    expect((await api("PATCH", "/api/me", { bio: "x".repeat(191) }, ana.token)).status).toBe(400);

    const r = await api("PATCH", "/api/me", { bio: "  Jogo Valorant à noite 🎮  ", color: "#FF6A3D" }, ana.token);
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ displayName: "pf_ana", color: "#ff6a3d" });
    expect(r.body.bio).toBe("Jogo Valorant à noite 🎮");

    // Only the given fields change.
    expect((await api("PATCH", "/api/me", { displayName: "Ana" }, ana.token)).body.user).toMatchObject({ displayName: "Ana", color: "#ff6a3d" });
    const seen = await api("GET", `/api/users/${ana.user.id}/profile`, undefined, bia.token);
    expect(seen.body).toMatchObject({ user: { displayName: "Ana", color: "#ff6a3d" }, bio: "Jogo Valorant à noite 🎮" });
    expect(seen.body.createdAt).toBeGreaterThan(0);

    // The color travels with messages too.
    const { body } = await api("POST", "/api/servers", { name: "Perfil" }, ana.token);
    const geral = body.channels.find((c: { type: string }) => c.type === "text").id;
    expect((await api("POST", `/api/channels/${geral}/messages`, { content: "oi" }, ana.token)).body.message.author.color).toBe("#ff6a3d");

    // Clearing.
    const cleared = await api("PATCH", "/api/me", { bio: "", color: null }, ana.token);
    expect(cleared.body).toMatchObject({ bio: null, user: { color: null } });
    expect((await api("GET", "/api/users/nao-existe/profile", undefined, bia.token)).status).toBe(404);
  });
});
