import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import type { Mail } from "../src/mail.ts";

let base = "";
let close: () => Promise<void>;
const sent: Mail[] = [];
const db = openDb(":memory:");

beforeAll(async () => {
  const { http, io } = createApp({ db, mailer: { send: async (m) => void sent.push(m) }, appUrl: "https://voxa.example/" });
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
const linkIn = (m: Mail, path: string) => m.text.match(new RegExp(`https://voxa\\.example/${path}/([\\w-]+)`))![1];

describe("e-mail and forgotten passwords", () => {
  it("confirms an address, then resets the password with a one-time link", async () => {
    expect((await api("GET", "/api/auth/options")).body).toEqual({ passwordReset: true });
    const { token, user } = (await api("POST", "/api/auth/register", { username: "esquecida", password: "senha-antiga" })).body;
    const other = (await api("POST", "/api/auth/register", { username: "outra", password: "senha-segura" })).body;

    // No confirmed e-mail yet: asking for a reset sends nothing (and says the same thing).
    expect((await api("POST", "/api/auth/forgot", { login: "esquecida" })).body).toEqual({ ok: true });
    expect(sent).toHaveLength(0);

    expect((await api("PUT", "/api/me/email", { email: "eu@exemplo.com", password: "errada" }, token)).status).toBe(400);
    expect((await api("PUT", "/api/me/email", { email: "não é email", password: "senha-antiga" }, token)).status).toBe(400);
    expect((await api("PUT", "/api/me/email", { email: "eu@exemplo.com", password: "senha-antiga" }, token)).body).toEqual({ pending: "eu@exemplo.com" });
    expect(sent.at(-1)!.to).toBe("eu@exemplo.com");
    expect((await api("GET", "/api/me", undefined, token)).body.email).toBeNull();

    const verify = linkIn(sent.at(-1)!, "verify-email");
    expect((await api("POST", "/api/auth/verify-email", { token: verify })).body).toEqual({ email: "eu@exemplo.com" });
    expect((await api("POST", "/api/auth/verify-email", { token: verify })).status).toBe(400);
    expect((await api("GET", "/api/me", undefined, token)).body.email).toBe("eu@exemplo.com");

    // Another account can't confirm the same address.
    await api("PUT", "/api/me/email", { email: "EU@exemplo.com", password: "senha-segura" }, other.token);
    expect((await api("POST", "/api/auth/verify-email", { token: linkIn(sent.at(-1)!, "verify-email") })).status).toBe(409);

    // Forgot by e-mail (any case) or username; only the hash of the token is stored.
    await api("POST", "/api/auth/forgot", { login: "Eu@Exemplo.com" });
    const reset = linkIn(sent.at(-1)!, "reset");
    expect(sent.at(-1)!.html).toContain(`https://voxa.example/reset/${reset}`);
    expect(JSON.stringify(db.prepare("SELECT * FROM email_tokens").all())).not.toContain(reset);
    expect((await api("POST", "/api/auth/reset", { token: reset, password: "curta" })).status).toBe(400);

    const done = await api("POST", "/api/auth/reset", { token: reset, password: "senha-nova-123" });
    expect(done.body.user.id).toBe(user.id);
    expect((await api("GET", "/api/me", undefined, token)).status).toBe(401); // old sessions are signed out
    expect((await api("GET", "/api/me", undefined, done.body.token)).status).toBe(200);
    expect((await api("POST", "/api/auth/login", { username: "esquecida", password: "senha-nova-123" })).status).toBe(200);
    expect((await api("POST", "/api/auth/reset", { token: reset, password: "outra-senha-1" })).status).toBe(400);

    // Expired links don't work.
    await api("POST", "/api/auth/forgot", { login: "esquecida" });
    const late = linkIn(sent.at(-1)!, "reset");
    db.prepare("UPDATE email_tokens SET expires_at = 0").run();
    expect((await api("POST", "/api/auth/reset", { token: late, password: "senha-nova-456" })).status).toBe(400);
  });
});

describe("without e-mail configured", () => {
  it("says so instead of pretending to send", async () => {
    const { http, io } = createApp({ db: openDb(":memory:") });
    await new Promise<void>((r) => http.listen(0, r));
    const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    expect(await (await fetch(url + "/api/auth/options")).json()).toEqual({ passwordReset: false });
    const r = await fetch(url + "/api/auth/forgot", { method: "POST", headers: { "content-type": "application/json" }, body: '{"login":"x"}' });
    expect(r.status).toBe(503);
    await new Promise<void>((res) => io.close(() => res()));
  });
});
