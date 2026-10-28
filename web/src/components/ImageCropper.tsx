// Crop a picked image for a server banner (16:9) or icon (square, shown round):
// drag to position, slider to zoom. The result is rendered at the final size and
// encoded in the browser, so the upload is small.

import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { ServerImageKind } from "../api.ts";

const MAX_BYTES = 2 * 1024 * 1024;

/** On-screen frame and output size for each kind. */
const SHAPES: Record<ServerImageKind, { frameW: number; frameH: number; outW: number; outH: number; title: string; hint: string }> = {
  banner: { frameW: 480, frameH: 270, outW: 960, outH: 540, title: "Recortar banner", hint: "O banner aparece no topo da lista de canais." },
  icon: { frameW: 256, frameH: 256, outW: 256, outH: 256, title: "Recortar ícone", hint: "O ícone aparece na barra de servidores." },
};

interface Props {
  file: File;
  kind: ServerImageKind;
  onCancel: () => void;
  onCropped: (image: Blob) => Promise<void>;
}

/** Encodes the canvas, preferring WebP, then JPEG, so the result stays under the upload limit. */
async function encode(canvas: HTMLCanvasElement): Promise<Blob> {
  const attempt = (type: string, q?: number) => new Promise<Blob | null>((r) => canvas.toBlob(r, type, q));
  for (const [type, q] of [["image/webp", 0.85], ["image/jpeg", 0.85], ["image/jpeg", 0.7]] as const) {
    const blob = await attempt(type, q);
    // Browsers without a WebP encoder silently return PNG; skip those.
    if (blob && blob.type === type && blob.size <= MAX_BYTES) return blob;
  }
  throw new Error("Não foi possível preparar a imagem.");
}

export function ImageCropper({ file, kind, onCancel, onCropped }: Props) {
  const { frameW: FRAME_W, frameH: FRAME_H, outW, outH, title, hint } = SHAPES[kind];
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => setImg(image);
    image.onerror = () => setError("Esse arquivo não é uma imagem que o navegador consiga abrir.");
    image.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onCancel]);

  // At zoom 1 the image just covers the frame; the offset is limited so no empty area shows.
  const base = img ? Math.max(FRAME_W / img.naturalWidth, FRAME_H / img.naturalHeight) : 1;
  const w = img ? img.naturalWidth * base * zoom : 0;
  const h = img ? img.naturalHeight * base * zoom : 0;
  const clamp = (o: { x: number; y: number }) => ({
    x: Math.min(0, Math.max(FRAME_W - w, o.x)),
    y: Math.min(0, Math.max(FRAME_H - h, o.y)),
  });
  const pos = clamp(offset);

  // Center the image when it loads or when zoom changes the size.
  const centered = useRef(false);
  useEffect(() => {
    if (img && !centered.current) {
      centered.current = true;
      setOffset({ x: (FRAME_W - w) / 2, y: (FRAME_H - h) / 2 });
    }
  }, [img, w, h]);

  const changeZoom = (z: number) => {
    // Zoom around the frame's center.
    const cx = FRAME_W / 2 - pos.x;
    const cy = FRAME_H / 2 - pos.y;
    const k = z / zoom;
    setZoom(z);
    setOffset({ x: FRAME_W / 2 - cx * k, y: FRAME_H / 2 - cy * k });
  };

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: pos.x, oy: pos.y };
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d) setOffset(clamp({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y }));
  };

  const apply = async () => {
    if (!img) return;
    setBusy(true);
    setError(null);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext("2d")!;
      const scale = outW / FRAME_W;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, pos.x * scale, pos.y * scale, w * scale, h * scale);
      await onCropped(await encode(canvas));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop cropper-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal cropper" role="dialog" aria-label={title}>
        <h2>{title}</h2>
        <p className="muted small">Arraste a imagem para enquadrar. {hint}</p>
        <div
          className={`crop-frame ${kind}`}
          style={{ width: FRAME_W, height: FRAME_H }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
        >
          {img && (
            <img
              src={img.src}
              alt=""
              draggable={false}
              style={{ width: w, height: h, transform: `translate(${pos.x}px, ${pos.y}px)` }}
            />
          )}
        </div>
        <label className="zoom-row">
          Zoom
          <input type="range" min={1} max={3} step={0.01} value={zoom} onChange={(e) => changeZoom(Number(e.target.value))} disabled={!img} />
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button className="btn subtle" onClick={onCancel}>
            Cancelar
          </button>
          <button className="btn primary" onClick={apply} disabled={!img || busy}>
            {busy ? "Enviando…" : "Aplicar"}
          </button>
        </div>
      </div>
    </div>
  );
}
