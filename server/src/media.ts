// Uploaded server images (banner and icon), stored as files in the media directory,
// which lives next to the database so it is on the persistent disk in production.
//
// The browser already crops and resizes them (banner 960x540, icon 256x256) before
// uploading, so the server only checks that the bytes really are an image and stores them.

import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export const IMAGE_KINDS = ["banner", "icon"] as const;
export type ImageKind = (typeof IMAGE_KINDS)[number];

/** URL prefix each kind is served under (see app.ts), e.g. /media/banners/. */
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
    save(kind: ImageKind, serverId: string, data: Buffer, type: ImageType): string {
      const hash = createHash("sha256").update(data).digest("hex").slice(0, 16);
      const file = `${serverId}-${hash}.${type}`;
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
