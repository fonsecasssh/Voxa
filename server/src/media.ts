// Uploaded images (server banner and icon, user avatar and profile banner) and chat clips, stored as files in the media directory,
// which lives next to the database so it is on the persistent disk in production.
//
// The browser already crops and resizes them (e.g. banner 960x540, icon/avatar 256x256) before
// uploading, so the server only checks that the bytes really are an image and stores them.

import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HttpError } from "./http.ts";

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
/** Animated GIFs (profile picture, server icon) are uploaded as they are, so they may be bigger. */
export const MAX_GIF_BYTES = 8 * 1024 * 1024;

/** Checks an upload's real type and size; returns the type. */
export function checkImage(data: Buffer): ImageType {
  const type = detectImageType(data);
  if (!type) throw new HttpError(400, "Envie uma imagem PNG, JPEG, WebP ou GIF.");
  if (type !== "gif" && data.length > MAX_IMAGE_BYTES) throw new HttpError(413, "A imagem passa de 2 MB.");
  return type;
}

export const SERVER_IMAGE_KINDS = ["banner", "icon"] as const;
export const USER_IMAGE_KINDS = ["avatar", "profile-banner"] as const;
export const IMAGE_KINDS = [...SERVER_IMAGE_KINDS, ...USER_IMAGE_KINDS] as const;
export type ServerImageKind = (typeof SERVER_IMAGE_KINDS)[number];
export type UserImageKind = (typeof USER_IMAGE_KINDS)[number];
export type ImageKind = (typeof IMAGE_KINDS)[number];

/** URL prefix each kind is served under (see app.ts), e.g. /media/banners/ or /media/avatars/. */
export const imageUrlPrefix = (kind: ImageKind) => `/media/${kind}s/`;

type ImageType = "png" | "jpg" | "webp" | "gif";

/** Recognizes an image by its first bytes (never by the declared content type). */
export function detectImageType(buf: Buffer): ImageType | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString("ascii", 0, 6))) return "gif";
  return null;
}

export function createMediaStore(dir: string) {
  const dirs = Object.fromEntries(IMAGE_KINDS.map((k) => [k, path.join(dir, `${k}s`)])) as Record<ImageKind, string>;
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

  return {
    dirs,

    /**
     * Saves an image and returns its file name. The name includes a hash of the content,
     * so it can be cached forever: a new image always gets a new URL.
     */
    save(kind: ImageKind, ownerId: string, data: Buffer, type: ImageType): string {
      const hash = createHash("sha256").update(data).digest("hex").slice(0, 16);
      const file = `${ownerId}-${hash}.${type}`;
      writeFileSync(path.join(dirs[kind], file), data);
      return file;
    },

    remove(kind: ImageKind, file: string | null) {
      // Only plain names we generated; never follow a path out of the directory.
      if (!file || file !== path.basename(file)) return;
      rmSync(path.join(dirs[kind], file), { force: true });
    },
  };
}

export type MediaStore = ReturnType<typeof createMediaStore>;

// --- clips -------------------------------------------------------------------------
// Instant replays shared in chat. The browser records and packages them (MP4 or WebM);
// the server streams the upload to disk, checks it really is a video, and keeps the clip
// folder under a total size by deleting the oldest clips (their messages then say so).

export const MAX_CLIP_BYTES = 100 * 1024 * 1024;

export type ClipType = "mp4" | "webm";
export const CLIP_MIME: Record<ClipType, string> = { mp4: "video/mp4", webm: "video/webm" };
export const CLIP_URL_PREFIX = "/media/clips/";

/** Recognizes MP4 ("ftyp" box first) and WebM (EBML header with the "webm" doc type). */
export function detectClipType(buf: Buffer): ClipType | null {
  if (buf.length >= 12 && buf.toString("ascii", 4, 8) === "ftyp") return "mp4";
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x1a45dfa3 && buf.subarray(0, 64).includes("webm")) return "webm";
  return null;
}

export function createClipStore(dir: string, maxTotalBytes: number, maxClipBytes = MAX_CLIP_BYTES) {
  mkdirSync(dir, { recursive: true });
  // Uploads cut short by a restart.
  for (const f of readdirSync(dir)) if (f.startsWith(".upload-")) rmSync(path.join(dir, f), { force: true });

  return {
    dir,
    maxClipBytes,

    /** Streams an upload into a temporary file (dot files are never served), enforcing the size limit. */
    async receive(body: Readable): Promise<{ tmp: string; size: number; type: ClipType | null }> {
      const tmp = path.join(dir, `.upload-${randomUUID()}`);
      let size = 0;
      let head = Buffer.alloc(0);
      const count = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          size += chunk.length;
          if (size > maxClipBytes) return cb(new HttpError(413, `O clipe passa de ${Math.round(maxClipBytes / 1024 / 1024)} MB.`));
          if (head.length < 64) head = Buffer.concat([head, chunk]).subarray(0, 64);
          cb(null, chunk);
        },
      });
      try {
        await pipeline(body, count, createWriteStream(tmp));
      } catch (err) {
        rmSync(tmp, { force: true });
        throw err instanceof HttpError ? err : new HttpError(400, "O envio do clipe foi interrompido.");
      }
      return { tmp, size, type: detectClipType(head) };
    },

    /** Moves a received upload to its final name, `<id>.<type>`. */
    commit(tmp: string, id: string, type: ClipType): string {
      const file = `${id}.${type}`;
      renameSync(tmp, path.join(dir, file));
      return file;
    },

    discard(tmp: string) {
      rmSync(tmp, { force: true });
    },

    /** Deletes a clip whose message was deleted. */
    remove(file: string) {
      if (file !== path.basename(file) || file.startsWith(".")) return;
      rmSync(path.join(dir, file), { force: true });
    },

    /** Deletes the oldest clips until the folder fits (never `keep`); returns the ids (file names without extension). */
    evict(keep: string): string[] {
      const files = readdirSync(dir)
        .filter((f) => !f.startsWith("."))
        .map((f) => {
          const s = statSync(path.join(dir, f));
          return { f, size: s.size, at: s.mtimeMs };
        })
        .sort((a, b) => a.at - b.at);
      let total = files.reduce((t, x) => t + x.size, 0);
      const removed: string[] = [];
      for (const x of files) {
        if (total <= maxTotalBytes) break;
        if (x.f === keep) continue;
        rmSync(path.join(dir, x.f), { force: true });
        total -= x.size;
        removed.push(x.f.replace(/\.[^.]+$/, ""));
      }
      return removed;
    },
  };
}

export type ClipStore = ReturnType<typeof createClipStore>;
