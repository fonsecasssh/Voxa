// Files in chat: the ones being picked for the next message (uploaded right away, in the
// background, so sending is instant), and the ones shown inside messages.

import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_FILES_PER_MESSAGE, MAX_FILE_BYTES, api, type FileAttachment } from "../api.ts";
import { Icon } from "./Icon.tsx";
import { formatSize } from "./ReplayModal.tsx";

export interface PendingFile {
  key: string;
  file: File;
  /** Object URL for an image thumbnail. */
  preview: string | null;
  progress: number;
  upload: FileAttachment | null;
  error: string | null;
}

/** Pixel size of an image or video, so the message can reserve its space before it loads. */
async function mediaSize(file: File): Promise<{ width?: number; height?: number }> {
  try {
    if (file.type.startsWith("image/")) {
      const bmp = await createImageBitmap(file);
      const size = { width: bmp.width, height: bmp.height };
      bmp.close();
      return size;
    }
    if (file.type.startsWith("video/")) {
      const url = URL.createObjectURL(file);
      const v = document.createElement("video");
      v.preload = "metadata";
      v.src = url;
      const size = await new Promise<{ width?: number; height?: number }>((resolve) => {
        v.onloadedmetadata = () => resolve({ width: v.videoWidth, height: v.videoHeight });
        v.onerror = () => resolve({});
        setTimeout(() => resolve({}), 3000);
      });
      URL.revokeObjectURL(url);
      return size;
    }
  } catch {
    // Unknown format: sent without a size.
  }
  return {};
}

/** Files picked for the next message. Each starts uploading as soon as it's added. */
export function usePendingFiles() {
  const [items, setItems] = useState<PendingFile[]>([]);
  const uploads = useRef(new Map<string, Promise<FileAttachment>>());
  const removed = useRef(new Set<string>());
  const latest = useRef(items);
  latest.current = items;

  const patch = (key: string, p: Partial<PendingFile>) => setItems((list) => list.map((x) => (x.key === key ? { ...x, ...p } : x)));

  /** Adds files; returns a message when some were refused (too big, too many). */
  const add = useCallback((files: File[]): string | null => {
    let error: string | null = null;
    const room = MAX_FILES_PER_MESSAGE - latest.current.length;
    if (files.length > room) error = `Você pode enviar até ${MAX_FILES_PER_MESSAGE} arquivos por mensagem.`;
    const accepted: PendingFile[] = [];
    for (const file of files.slice(0, Math.max(0, room))) {
      if (file.size > MAX_FILE_BYTES) {
        error = `“${file.name}” passa de ${MAX_FILE_BYTES / 1024 / 1024} MB.`;
        continue;
      }
      const key = crypto.randomUUID();
      accepted.push({ key, file, preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null, progress: 0, upload: null, error: null });
      const job = mediaSize(file).then((size) => api.uploadFile(file, size, (progress) => patch(key, { progress })));
      uploads.current.set(key, job);
      job.then(
        (upload) => {
          // Removed while it was still uploading: delete it from the server too.
          if (removed.current.has(key)) api.deleteUpload(upload.id).catch(() => {});
          else patch(key, { upload, progress: 1 });
        },
        (err: Error) => patch(key, { error: err.message }),
      );
    }
    if (accepted.length) setItems((list) => [...list, ...accepted]);
    return error;
  }, []);

  const remove = useCallback((key: string) => {
    const item = latest.current.find((x) => x.key === key);
    if (!item) return;
    if (item.preview) URL.revokeObjectURL(item.preview);
    if (item.upload) api.deleteUpload(item.upload.id).catch(() => {});
    else removed.current.add(key);
    uploads.current.delete(key);
    setItems((list) => list.filter((x) => x.key !== key));
  }, []);

  /** Forgets the files once they were sent (they belong to the message now). */
  const clear = useCallback(() => {
    for (const x of latest.current) if (x.preview) URL.revokeObjectURL(x.preview);
    uploads.current.clear();
    setItems([]);
  }, []);

  /** Drops everything, deleting the uploads (e.g. when switching channels). */
  const discard = useCallback(() => {
    for (const x of latest.current) remove(x.key);
  }, [remove]);

  /** Waits for every file to finish uploading; their ids, in order. */
  const ready = useCallback(async (): Promise<string[]> => {
    const list = latest.current;
    const done = await Promise.all(list.map((x) => uploads.current.get(x.key)!));
    return done.map((u) => u.id);
  }, []);

  useEffect(() => () => latest.current.forEach((x) => x.preview && URL.revokeObjectURL(x.preview)), []);

  return { items, add, remove, clear, discard, ready };
}

/** The files waiting to be sent, above the message box. */
export function PendingTray({ items, onRemove }: { items: PendingFile[]; onRemove: (key: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="pending-files" aria-label="Arquivos para enviar">
      {items.map((x) => (
        <div key={x.key} className={`pending-file ${x.error ? "failed" : ""}`}>
          <div className="pending-thumb">
            {x.preview ? <img src={x.preview} alt="" /> : <Icon name="file" size={30} />}
            {!x.upload && !x.error && (
              <span className="pending-progress" aria-label={`Enviando ${Math.round(x.progress * 100)}%`}>
                <span style={{ width: `${Math.round(x.progress * 100)}%` }} />
              </span>
            )}
          </div>
          <span className="pending-name ellipsis" title={x.file.name}>
            {x.file.name}
          </span>
          <span className={`small ${x.error ? "form-error" : "muted"}`}>{x.error ?? formatSize(x.file.size)}</span>
          <button type="button" className="pending-remove" title="Remover" aria-label={`Remover ${x.file.name}`} onClick={() => onRemove(x.key)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Files inside a message: images and videos inline, anything else as a download card. */
export function MessageFiles({ files, onOpenImage }: { files: FileAttachment[]; onOpenImage: (f: FileAttachment) => void }) {
  const media = files.filter((f) => f.url && (f.kind === "image" || f.kind === "video"));
  const others = files.filter((f) => !media.includes(f));
  return (
    <div className="message-files">
      {media.length > 0 && (
        <div className={`media-grid ${media.length === 1 ? "single" : ""}`}>
          {media.map((f) =>
            f.kind === "image" ? (
              <button
                key={f.id}
                type="button"
                className="media-item"
                style={media.length === 1 && f.width && f.height ? { aspectRatio: `${f.width} / ${f.height}` } : undefined}
                onClick={() => onOpenImage(f)}
                aria-label={`Abrir ${f.name}`}
              >
                <img src={f.url!} alt={f.name} loading="lazy" />
              </button>
            ) : (
              <video
                key={f.id}
                className="media-item"
                src={f.url!}
                controls
                preload="metadata"
                playsInline
                style={media.length === 1 && f.width && f.height ? { aspectRatio: `${f.width} / ${f.height}` } : undefined}
              />
            ),
          )}
        </div>
      )}
      {others.map((f) =>
        f.url ? (
          <a key={f.id} className="file-card" href={f.url} download={f.name}>
            <Icon name="file" size={28} />
            <span className="file-card-texts">
              <span className="file-card-name ellipsis">{f.name}</span>
              <span className="muted small">{formatSize(f.size)}</span>
            </span>
            <Icon name="save" size={20} />
          </a>
        ) : (
          <div key={f.id} className="file-card expired">
            <Icon name="file" size={28} />
            <span className="muted small">“{f.name}” expirou para liberar espaço no servidor.</span>
          </div>
        ),
      )}
    </div>
  );
}

/** An image opened over the app, with a link to the original. */
export function Lightbox({ file, onClose }: { file: FileAttachment; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="lightbox" role="dialog" aria-label={file.name} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <img src={file.url!} alt={file.name} />
      <div className="lightbox-bar">
        <span className="ellipsis">{file.name}</span>
        <a href={file.url!} target="_blank" rel="noopener noreferrer">
          Abrir original
        </a>
        <button type="button" className="tile-btn" onClick={onClose} aria-label="Fechar">
          <Icon name="close" size={16} />
        </button>
      </div>
    </div>
  );
}
