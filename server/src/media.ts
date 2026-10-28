// Uploaded images (server banners), stored as files in the media directory,
// which lives next to the database so it is on the persistent disk in production.
//
// The browser already crops and resizes banners to 960x540 before uploading, so
// the server only checks that the bytes really are an image and stores them.

import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MAX_BANNER_BYTES = 2 * 1024 * 1024;

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
  const bannersDir = path.join(dir, "banners");
  mkdirSync(bannersDir, { recursive: true });

  return {
    bannersDir,

    /**
     * Saves a banner and returns its file name. The name includes a hash of the content,
     * so it can be cached forever: a new banner always gets a new URL.
     */
    saveBanner(serverId: string, data: Buffer, type: ImageType): string {
      const hash = createHash("sha256").update(data).digest("hex").slice(0, 16);
      const file = `${serverId}-${hash}.${type}`;
      writeFileSync(path.join(bannersDir, file), data);
      return file;
    },

    removeBanner(file: string | null) {
      // Only plain names we generated; never follow a path out of the directory.
      if (!file || file !== path.basename(file)) return;
      rmSync(path.join(bannersDir, file), { force: true });
    },
  };
}

export type MediaStore = ReturnType<typeof createMediaStore>;
