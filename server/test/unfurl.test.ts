import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { io as connect } from "socket.io-client";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { createUnfurler, isPrivateAddress, parseHtml, youtubeId } from "../src/unfurl.ts";
import { previewLinks } from "../../shared/markdown.ts";

describe("link preview safety", () => {
  it("knows private and special addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fc00::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("refuses local addresses, odd ports and non-http links", async () => {
    const u = createUnfurler();
    for (const url of ["http://127.0.0.1/", "http://localhost/", "http://[::1]/", "http://169.254.169.254/latest/meta-data", "http://example.com:8080/", "ftp://example.com/", "file:///etc/passwd"]) {
      expect(await u.preview(url), url).toBeNull();
    }
  });

  it("only previews links outside code and spoilers, at most 3, not GIF picks", () => {
    expect(previewLinks("veja https://a.com e `https://b.com` e ||https://c.com|| e https://a.com")).toEqual(["https://a.com/"]);
    expect(previewLinks("https://1.com https://2.com https://3.com https://4.com")).toHaveLength(3);
    expect(previewLinks("https://media.giphy.com/media/abc/giphy.gif")).toEqual([]);
  });

  it("reads Open Graph tags and YouTube ids", () => {
    const e = parseHtml(
      `<html><head><title>Fallback</title><meta property="og:title" content="Jogo &amp; Cia"><meta name='description' content='Tudo sobre jogos'>
       <meta property="og:image" content="/capa.png"><meta property="og:site_name" content="Gamer"><meta name="theme-color" content="#ff8800"></head></html>`,
      "https://site.com/artigo",
    );
    expect(e).toEqual({ url: "https://site.com/artigo", kind: "link", title: "Jogo & Cia", description: "Tudo sobre jogos", image: "https://site.com/capa.png", siteName: "Gamer", color: "#ff8800" });
    expect(parseHtml("<html><body>nada</body></html>", "https://x.com")).toBeNull();
    expect(youtubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1")).toBe("dQw4w9WgXcQ");
    expect(youtubeId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeId("https://youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });
});

describe("previews in chat", () => {
  let site: Server;
  let siteUrl = "";
  let hits = 0;
  let base = "";
  let close: () => Promise<void>;
  beforeAll(async () => {
    site = createServer((req, res) => {
      hits++;
      if (req.url === "/ir") return void res.writeHead(302, { location: "/pagina" }).end();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<html><head><meta property="og:title" content="Página de teste"><meta property="og:description" content="Descrição"></head></html>`);
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    // Only this test may reach a local page.
    const { http, io } = createApp({ db: openDb(":memory:"), unfurler: createUnfurler({ allowPrivate: true }) });
    await new Promise<void>((r) => http.listen(0, r));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    close = () => new Promise((r) => io.close(() => r()));
  });
  afterAll(async () => {
    await close();
    site.close();
  });

  it("sends the message again with its preview, and caches it", async () => {
    const post = async (path: string, body: unknown, token?: string) =>
      (await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })).json();
    const me = await post("/api/auth/register", { username: "embed_ana", password: "senha-segura" });
    const created = await post("/api/servers", { name: "Embeds" }, me.token);
    const ch = created.channels.find((c: { type: string }) => c.type === "text").id;
    const s = connect(base, { auth: { token: me.token }, transports: ["websocket"] });
    await new Promise((r) => s.on("connect", r));
    const updated = new Promise<{ embeds: { title: string; url: string }[] }>((r) => s.on("message:update", r));
    const sent = await post(`/api/channels/${ch}/messages`, { content: `olha ${siteUrl}/ir` }, me.token);
    expect(sent.message.embeds).toEqual([]);
    const m = await updated;
    expect(m.embeds).toEqual([expect.objectContaining({ url: `${siteUrl}/ir`, title: "Página de teste", description: "Descrição" })]);
    // Loading the channel shows it too; the same link again uses the cache.
    const before = hits;
    const again = await post(`/api/channels/${ch}/messages`, { content: `de novo ${siteUrl}/ir` }, me.token);
    expect(again.message.embeds).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(hits).toBe(before);
    s.close();
  });
});
