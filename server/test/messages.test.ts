import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { io as connect, type Socket } from "socket.io-client";
import { createApp, isEmoji } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { createIceProvider } from "../src/ice.ts";
import { createGiphyProvider } from "../src/gifs.ts";

let base = "";
let close: () => Promise<void>;
beforeAll(async () => {
  const { http, io } = createApp({ db: openDb(":memory:"), ice: createIceProvider({}) });
  await new Promise<void>((r) => http.listen(0, r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  close = () => new Promise((r) => io.close(() => r()));
});
afterAll(() => close());

async function api(method: string, p: string, body?: unknown, token?: string) {
  const res = await fetch(base + p, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
let n = 0;
async function user() {
  return (await api("POST", "/api/auth/register", { username: `msg${++n}`, password: "senha-segura" })).body as { token: string; user: { id: string } };
}

async function setup() {
  const owner = await user();
  const friend = await user();
  const { server, inviteCode } = (await api("POST", "/api/servers", { name: "Conversa" }, owner.token)).body;
  await api("POST", `/api/invites/${inviteCode}`, undefined, friend.token);
  const channels = (await api("GET", `/api/servers/${server.id}`, undefined, owner.token)).body.channels;
  const general = channels.find((c: { type: string }) => c.type === "text");
  const other = (await api("POST", `/api/servers/${server.id}/channels`, { name: "outro", type: "text" }, owner.token)).body.channel;
  const say = async (who: { token: string }, content: string, extra: object = {}, channelId = general.id) =>
    api("POST", `/api/channels/${channelId}/messages`, { content, ...extra }, who.token);
  const listen = async (who: { token: string }) => {
    const s: Socket = connect(base, { auth: { token: who.token }, transports: ["websocket"] });
    const events: { e: string; d: any }[] = [];
    for (const e of ["message:update", "message:reactions"]) s.on(e, (d) => events.push({ e, d }));
    await new Promise<void>((r) => s.on("connect", () => r()));
    return { s, events };
  };
  return { owner, friend, general, other, say, listen };
}

describe("isEmoji", () => {
  it("accepts emojis with modifiers, flags and keycaps, and nothing else", () => {
    for (const e of ["😂", "❤️", "👍🏽", "👨‍👩‍👧", "🇧🇷", "1️⃣", "🏳️‍🌈"]) expect(isEmoji(e)).toBe(true);
    for (const e of ["", "a", "ok", "<b>", "😂 oi", "x😂", "😂".repeat(20)]) expect(isEmoji(e)).toBe(false);
  });
});

describe("replies", () => {
  it("quotes the original, refuses originals from other channels, and survives its deletion", async () => {
    const { owner, friend, say, general, other } = await setup();
    const original = (await say(owner, "quem joga hoje?")).body.message;
    const reply = await say(friend, "eu!", { replyTo: original.id });
    expect(reply.status).toBe(201);
    expect(reply.body.message.replyTo).toMatchObject({ id: original.id, content: "quem joga hoje?", author: { id: owner.user.id } });

    const elsewhere = (await say(owner, "em outro canal", {}, other.id)).body.message;
    expect((await say(friend, "x", { replyTo: elsewhere.id })).status).toBe(400);
    expect((await say(friend, "x", { replyTo: "nao-existe" })).status).toBe(400);

    await api("DELETE", `/api/channels/${general.id}/messages/${original.id}`, undefined, owner.token);
    const listed = (await api("GET", `/api/channels/${general.id}/messages`, undefined, friend.token)).body.messages;
    expect(listed.at(-1).replyTo).toEqual({ id: original.id, author: null, content: "", hasFiles: false });
  });
});

describe("editing", () => {
  it("lets only the author edit, marks it edited and tells everyone", async () => {
    const { owner, friend, say, general, listen } = await setup();
    const { s, events } = await listen(friend);
    const m = (await say(owner, "bora as 9")).body.message;
    expect(m.editedAt).toBeNull();
    const path = `/api/channels/${general.id}/messages/${m.id}`;
    expect((await api("PATCH", path, { content: "bora as 10" }, friend.token)).status).toBe(403);
    expect((await api("PATCH", path, { content: "   " }, owner.token)).status).toBe(400);
    const edited = await api("PATCH", path, { content: "bora as 10" }, owner.token);
    expect(edited.status).toBe(200);
    expect(edited.body.message.content).toBe("bora as 10");
    expect(edited.body.message.editedAt).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(events.find((x) => x.e === "message:update")?.d.content).toBe("bora as 10");
    s.close();
  });
});

describe("reactions", () => {
  it("adds and removes reactions per person, live, and caps the kinds", async () => {
    const { owner, friend, say, general, listen } = await setup();
    const { s, events } = await listen(owner);
    const m = (await say(owner, "ganhamos!")).body.message;
    const react = (who: { token: string }, emoji: string, method = "PUT") =>
      api(method, `/api/channels/${general.id}/messages/${m.id}/reactions/${encodeURIComponent(emoji)}`, undefined, who.token);

    expect((await react(friend, "🔥")).status).toBe(204);
    expect((await react(owner, "🔥")).status).toBe(204);
    expect((await react(owner, "🔥")).status).toBe(204); // twice is still once
    expect((await react(friend, "👏🏽")).status).toBe(204);
    expect((await react(friend, "<script>")).status).toBe(400);
    let listed = (await api("GET", `/api/channels/${general.id}/messages`, undefined, owner.token)).body.messages.at(-1);
    expect(listed.reactions).toEqual([
      { emoji: "🔥", userIds: [friend.user.id, owner.user.id] },
      { emoji: "👏🏽", userIds: [friend.user.id] },
    ]);
    expect((await react(friend, "🔥", "DELETE")).status).toBe(204);
    await new Promise((r) => setTimeout(r, 50));
    expect(events.filter((x) => x.e === "message:reactions").at(-1)?.d.reactions[0]).toEqual({ emoji: "🔥", userIds: [owner.user.id] });

    const many = ["😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😂", "🙂", "🙃", "😉", "😊", "😇", "🥰", "😍", "🤩", "😘", "😗"];
    for (const e of many) await react(owner, e);
    listed = (await api("GET", `/api/channels/${general.id}/messages`, undefined, owner.token)).body.messages.at(-1);
    expect(listed.reactions).toHaveLength(20);
    expect((await react(owner, "😚")).status).toBe(400);
    expect((await react(friend, "😀")).status).toBe(204); // an existing kind is still fine
    s.close();
  });
});

describe("mentions", () => {
  it("pings members by @name and by reply, @everyone only with permission, never the author", async () => {
    const { owner, friend, say } = await setup();
    const outsider = await user();
    const names = await Promise.all(
      [owner, friend, outsider].map(async (u) => (await api("GET", "/api/me", undefined, u.token)).body.user.username as string),
    );
    const [ownerName, friendName, outsiderName] = names;

    const m = (await say(owner, `@${friendName.toUpperCase()} e @${outsiderName} e @${ownerName} e \`@${friendName}\``)).body.message;
    expect(m.mentions).toEqual([friend.user.id]);
    expect(m.mentionsEveryone).toBe(false);

    const reply = (await say(friend, "beleza", { replyTo: m.id })).body.message;
    expect(reply.mentions).toEqual([owner.user.id]);

    expect((await say(friend, "@everyone acordem")).body.message.mentionsEveryone).toBe(false);
    expect((await say(owner, "@everyone acordem")).body.message.mentionsEveryone).toBe(true);
  });
});

describe("GIF search", () => {
  it("is off without a provider, and proxies (and caches) the provider when on", async () => {
    const owner = await user();
    expect((await api("GET", "/api/me", undefined, owner.token)).body.features).toEqual({ gifs: false, email: false });
    expect((await api("GET", "/api/gifs?q=gato", undefined, owner.token)).status).toBe(404);

    const calls: string[] = [];
    const gifs = {
      search: async (q: string, offset: number) => {
        calls.push(`search:${q}:${offset}`);
        return [{ id: "1", title: q, preview: "https://media.giphy.com/media/a/200w.webp", url: "https://media.giphy.com/media/a/giphy.gif", width: 480, height: 270 }];
      },
      trending: async () => {
        calls.push("trending");
        return [];
      },
    };
    const { http, io } = createApp({ db: openDb(":memory:"), ice: createIceProvider({}), gifs });
    await new Promise<void>((r) => http.listen(0, r));
    const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const reg = await (await fetch(url + "/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "gifeiro", password: "senha-segura" }) })).json();
    const get = (p: string) => fetch(url + p, { headers: { authorization: `Bearer ${reg.token}` } }).then(async (r) => ({ status: r.status, body: await r.json() }));
    expect((await get("/api/me")).body.features).toEqual({ gifs: true, email: false });
    const r = await get("/api/gifs?q=gato&offset=24");
    expect(r.body.gifs[0]).toMatchObject({ title: "gato", url: "https://media.giphy.com/media/a/giphy.gif" });
    await get("/api/gifs?q=GATO&offset=24");
    await get("/api/gifs");
    expect(calls).toEqual(["search:gato:24", "trending"]);
    expect((await fetch(url + "/api/gifs")).status).toBe(401);
    await new Promise((r) => io.close(() => r(null)));
  });
});

describe("createGiphyProvider", () => {
  it("asks GIPHY with the key and keeps the sizes it needs", async () => {
    let asked = "";
    const fakeFetch = (async (u: string) => {
      asked = u;
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "x1",
              title: "gato dançando",
              images: {
                downsized: { url: "https://media2.giphy.com/media/x1/giphy.gif?cid=abc", width: "480", height: "360" },
                fixed_width_small: { url: "https://media2.giphy.com/media/x1/100w.gif", webp: "https://media2.giphy.com/media/x1/100w.webp" },
              },
            },
            { id: "broken", images: {} },
          ],
        }),
      );
    }) as unknown as typeof fetch;
    const gifs = await createGiphyProvider("KEY", fakeFetch).search("gato", 0);
    expect(asked).toContain("api_key=KEY");
    expect(asked).toContain("q=gato");
    expect(gifs).toEqual([
      { id: "x1", title: "gato dançando", preview: "https://media2.giphy.com/media/x1/100w.webp", url: "https://media2.giphy.com/media/x1/giphy.gif", width: 480, height: 360 },
    ]);
  });
});
