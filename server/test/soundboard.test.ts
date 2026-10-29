import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { io as connect, type Socket } from "socket.io-client";
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
// A tiny WAV file (44-byte header and a few silent samples).
function wav(): Buffer {
  const samples = 16;
  const b = Buffer.alloc(44 + samples * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(samples * 2, 40);
  return b;
}
const socketFor = (token: string) =>
  new Promise<Socket>((resolve, reject) => {
    const s = connect(base, { auth: { token }, transports: ["websocket"] });
    s.on("connect", () => resolve(s));
    s.on("connect_error", reject);
  });
const emit = <T>(s: Socket, event: string, payload: unknown) => new Promise<T>((r) => s.emit(event, payload, r));
type Played = { channelId: string; userId: string; sound: { id: string; name: string; url: string | null; volume: number } };
const nextPlay = (s: Socket) => new Promise<Played>((r) => s.once("soundboard:play", r));

describe("soundboard", () => {
  it("manages a server's sounds and plays them to everyone in the voice channel", async () => {
    const dono = await register("sb_dono");
    const membro = await register("sb_membro");
    const fora = await register("sb_fora");
    const { body } = await api("POST", "/api/servers", { name: "Sons" }, dono.token);
    await api("POST", `/api/invites/${body.inviteCode}`, undefined, membro.token);
    const s = body.server.id;
    const voz = body.channels.find((c: { type: string }) => c.type === "voice").id;
    const other = (await api("POST", "/api/servers", { name: "Outro" }, fora.token)).body.server.id;

    // Managing needs the permission; the file must really be audio.
    expect((await api("POST", `/api/servers/${s}/sounds?name=Risada`, undefined, membro.token, wav())).status).toBe(403);
    expect((await api("POST", `/api/servers/${s}/sounds?name=Risada`, undefined, dono.token, Buffer.from("não é áudio, só texto"))).status).toBe(400);
    expect((await api("POST", `/api/servers/${s}/sounds?name=Risada&emoji=abc`, undefined, dono.token, wav())).status).toBe(400);
    const risada = (await api("POST", `/api/servers/${s}/sounds?name=Risada&emoji=😂&volume=0.5`, undefined, dono.token, wav())).body.sound;
    expect(risada).toMatchObject({ name: "Risada", emoji: "😂", volume: 0.5 });
    expect((await api("POST", `/api/servers/${s}/sounds?name=risada`, undefined, dono.token, wav())).status).toBe(409);
    const file = await fetch(base + risada.url);
    expect(file.headers.get("content-type")).toMatch(/audio\/(wav|x-wav|wave)/);
    expect((await api("GET", `/api/servers/${s}/sounds`, undefined, membro.token)).body.sounds.map((x: { name: string }) => x.name)).toEqual(["Risada"]);
    expect((await api("GET", `/api/servers/${s}/sounds`, undefined, fora.token)).status).toBe(404);
    expect((await api("PATCH", `/api/sounds/${risada.id}`, { name: "Gargalhada", volume: 0.8 }, dono.token)).body.sound).toMatchObject({ name: "Gargalhada", emoji: "😂", volume: 0.8 });

    // Playing: only from a voice channel, only this server's sounds (or the built-in ones).
    const sd = await socketFor(dono.token);
    const sm = await socketFor(membro.token);
    const sf = await socketFor(fora.token);
    expect(await emit(sm, "soundboard:play", { soundId: "default:buzina" })).toEqual({ error: "Entre num canal de voz para usar o soundboard." });
    await emit(sd, "voice:join", { channelId: voz });
    await emit(sm, "voice:join", { channelId: voz });
    const heard = nextPlay(sd);
    expect(await emit(sm, "soundboard:play", { soundId: risada.id })).toEqual({ ok: true });
    expect(await heard).toMatchObject({ channelId: voz, userId: membro.user.id, sound: { id: risada.id, name: "Gargalhada", url: risada.url, volume: 0.8 } });
    // Too soon after the last one.
    expect(await emit(sm, "soundboard:play", { soundId: "default:buzina" })).toEqual({ error: "Espere um pouco para tocar outro som." });
    const builtin = nextPlay(sm);
    expect(await emit(sd, "soundboard:play", { soundId: "default:tada" })).toEqual({ ok: true });
    expect((await builtin).sound).toMatchObject({ id: "default:tada", name: "Tadá", url: null });

    // Someone in another server's voice channel can't play this server's sound.
    const outraVoz = (await api("GET", `/api/servers/${other}`, undefined, fora.token)).body.channels.find((c: { type: string }) => c.type === "voice").id;
    await emit(sf, "voice:join", { channelId: outraVoz });
    expect(await emit(sf, "soundboard:play", { soundId: risada.id })).toEqual({ error: "Som não encontrado." });
    // Deafened: no soundboard.
    sf.emit("voice:state", { deafened: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(await emit(sf, "soundboard:play", { soundId: "default:grilos" })).toEqual({ error: "Ative o áudio para usar o soundboard." });

    // Deleting removes the file too.
    expect((await api("DELETE", `/api/sounds/${risada.id}`, undefined, dono.token)).status).toBe(204);
    expect((await fetch(base + risada.url)).status).toBe(404);
    for (const x of [sd, sm, sf]) x.close();
  });
});
