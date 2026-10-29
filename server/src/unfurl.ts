// Link previews ("embeds"): the title, description and picture of a page linked in chat,
// read from its Open Graph / Twitter tags (YouTube through its oEmbed API).
//
// The server fetches the page, so it must never be tricked into reaching places only it
// can reach (its own network, cloud metadata…): every address a name resolves to is
// checked, redirects are followed by hand and checked again, only ports 80/443, small
// bodies, short timeouts.

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export interface LinkEmbed {
  url: string;
  kind: "link" | "image" | "youtube";
  title: string | null;
  description: string | null;
  /** Picture (https only). */
  image: string | null;
  siteName: string | null;
  /** Accent color the page declares (theme-color). */
  color: string | null;
  youtubeId?: string;
}

/** Addresses that aren't the public internet. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const v6 = ip.toLowerCase();
    const mapped = v6.match(/^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/) ?? v6.match(/^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return (
      v6 === "::" ||
      v6 === "::1" ||
      /^f[cd]/.test(v6) || // unique local fc00::/7
      /^fe[89ab]/.test(v6) || // link-local fe80::/10
      /^ff/.test(v6) || // multicast
      v6.startsWith("2001:db8") ||
      v6.startsWith("::ffff:") ||
      v6.startsWith("64:ff9b:")
    );
  }
  return true;
}

const YOUTUBE = /^(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/i;
export const youtubeId = (url: string) => url.match(YOUTUBE)?.[1] ?? null;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&(\w+);/g, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();

const clip = (s: string | null | undefined, n: number) => (s ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null);

/** Reads the preview from a page's <head>. */
export function parseHtml(html: string, pageUrl: string): LinkEmbed | null {
  const meta = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attr = (name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
    const key = attr("property") ?? attr("name");
    const content = attr("content");
    if (!key || !content) continue;
    const k = (key[2] ?? key[3] ?? key[4]).toLowerCase();
    if (!meta.has(k)) meta.set(k, decode(content[2] ?? content[3] ?? content[4]));
  }
  const titleTag = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
  const title = meta.get("og:title") ?? meta.get("twitter:title") ?? (titleTag ? decode(titleTag) : null);
  const description = meta.get("og:description") ?? meta.get("twitter:description") ?? meta.get("description") ?? null;
  let image = meta.get("og:image") ?? meta.get("og:image:url") ?? meta.get("twitter:image") ?? null;
  if (image) {
    try {
      image = new URL(image, pageUrl).href;
      if (!image.startsWith("https://")) image = null;
    } catch {
      image = null;
    }
  }
  const color = meta.get("theme-color") ?? null;
  if (!title && !description && !image) return null;
  return {
    url: pageUrl,
    kind: "link",
    title: clip(title, 200),
    description: clip(description, 350),
    image,
    siteName: clip(meta.get("og:site_name") ?? null, 80),
    color: color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : null,
  };
}

export interface Unfurler {
  preview(url: string): Promise<LinkEmbed | null>;
}

interface FetchResult {
  status: number;
  type: string;
  body: Buffer;
  finalUrl: string;
}

export function createUnfurler({ allowPrivate = false, timeoutMs = 5000, maxBytes = 512 * 1024 } = {}): Unfurler {
  // Every address of the name is checked, then the connection goes to one of them (no second lookup).
  const safeLookup: net.LookupFunction = (hostname, options, callback) => {
    dns.lookup(hostname, { all: true, family: options.family ?? 0 }, (err, addrs) => {
      if (err) return (callback as (e: Error) => void)(err);
      const list = addrs as dns.LookupAddress[];
      if (!allowPrivate && (list.length === 0 || list.some((a) => isPrivateAddress(a.address)))) {
        return (callback as (e: Error) => void)(new Error("endereço não permitido"));
      }
      if ((options as { all?: boolean }).all) (callback as (e: null, a: dns.LookupAddress[]) => void)(null, list);
      else (callback as (e: null, a: string, f: number) => void)(null, list[0].address, list[0].family);
    });
  };

  const get = (raw: string, redirects = 3): Promise<FetchResult> =>
    new Promise((resolve, reject) => {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        return reject(new Error("link inválido"));
      }
      const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
      if ((url.protocol !== "https:" && url.protocol !== "http:") || (port !== 80 && port !== 443 && !allowPrivate)) return reject(new Error("link não permitido"));
      const host = url.hostname.replace(/^\[|\]$/g, "");
      if (net.isIP(host) && !allowPrivate && isPrivateAddress(host)) return reject(new Error("endereço não permitido"));
      const req = (url.protocol === "https:" ? https : http).request(
        url,
        {
          method: "GET",
          lookup: safeLookup,
          timeout: timeoutMs,
          headers: { "user-agent": "Mozilla/5.0 (compatible; VoxaBot/1.0; link preview)", accept: "text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5", "accept-language": "pt-BR,pt;q=0.9,en;q=0.6" },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            if (redirects <= 0) return reject(new Error("redirecionamentos demais"));
            return resolve(get(new URL(res.headers.location, url).href, redirects - 1));
          }
          const type = String(res.headers["content-type"] ?? "");
          // Pictures: the headers are enough.
          if (type.startsWith("image/")) {
            res.destroy();
            return resolve({ status, type, body: Buffer.alloc(0), finalUrl: url.href });
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            chunks.push(c);
            if (size >= maxBytes) res.destroy();
          });
          res.on("close", () => resolve({ status, type, body: Buffer.concat(chunks).subarray(0, maxBytes), finalUrl: url.href }));
          res.on("error", () => resolve({ status, type, body: Buffer.concat(chunks), finalUrl: url.href }));
        },
      );
      req.on("timeout", () => req.destroy(new Error("tempo esgotado")));
      req.on("error", reject);
      req.end();
    });

  return {
    async preview(url) {
      try {
        const yt = youtubeId(url);
        if (yt) {
          const r = await get(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${yt}`)}`);
          const o = r.status === 200 ? (JSON.parse(r.body.toString("utf8")) as { title?: string; author_name?: string }) : {};
          return {
            url,
            kind: "youtube",
            youtubeId: yt,
            title: clip(o.title ?? null, 200),
            description: null,
            image: `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`,
            siteName: o.author_name ? `YouTube · ${clip(o.author_name, 60)}` : "YouTube",
            color: "#ff0033",
          };
        }
        const r = await get(url);
        if (r.status !== 200) return null;
        if (r.type.startsWith("image/")) {
          return r.finalUrl.startsWith("https://") ? { url, kind: "image", title: null, description: null, image: r.finalUrl, siteName: null, color: null } : null;
        }
        if (!/html/i.test(r.type)) return null;
        const charset = r.type.match(/charset=([\w-]+)/i)?.[1] ?? "utf-8";
        let html: string;
        try {
          html = new TextDecoder(charset).decode(r.body);
        } catch {
          html = r.body.toString("utf8");
        }
        const embed = parseHtml(html, r.finalUrl);
        return embed && { ...embed, url };
      } catch {
        return null;
      }
    },
  };
}
