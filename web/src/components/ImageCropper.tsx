// Crop a picked image for a server banner (16:9) or icon (square, shown round):
// drag to position, slider to zoom. The result is rendered at the final size and
// encoded in the browser, so the upload is small.
//
// An animated GIF for a profile picture or server icon is sent as it is instead
// (drawing it on a canvas would keep only its first frame); it is shown centered.

import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { ServerImageKind } from "../api.ts";

export type CropKind = ServerImageKind | "avatar" | "profileBanner";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_GIF_BYTES = 8 * 1024 * 1024;
/** Kinds that may be an animated GIF. */
const ANIMATABLE: CropKind[] = ["avatar", "icon"];

/** On-screen frame and output size for each kind. */
const SHAPES: Record<CropKind, { frameW: number; frameH: number; outW: number; outH: number; round: boolean; title: string; hint: string }> = {
  banner: { frameW: 480, frameH: 270, outW: 960, outH: 540, round: false, title: "Recortar banner", hint: "O banner aparece no topo da lista de canais." },
  icon: { frameW: 256, frameH: 256, outW: 256, outH: 256, round: true, title: "Recortar ícone", hint: "O ícone aparece na barra de servidores." },
  avatar: { frameW: 256, frameH: 256, outW: 256, outH: 256, round: true, title: "Recortar foto de perfil", hint: "Sua foto aparece no chat, na lista de membros e na voz." },
  profileBanner: { frameW: 480, frameH: 192, outW: 600, outH: 240, round: false, title: "Recortar banner do perfil", hint: "Aparece no topo do seu cartão de perfil." },
};

interface Props {
  file: File;
  kind: CropKind;
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

export function ImageCropper(props: Props) {
  const [still, setStill] = useState(false);
  const gif = props.file.type === "image/gif" && ANIMATABLE.includes(props.kind);
  return gif && !still ? <GifPreview {...props} onCropStill={() => setStill(true)} /> : <StillCropper {...props} />;
}

/** Shows an animated GIF in its final shape and uploads it untouched. */
function GifPreview({ file, kind, onCancel, onCropped, onCropStill }: Props & { onCropStill: () => void }) {
  const { frameW, frameH, round } = SHAPES[kind];
  const [url] = useState(() => URL.createObjectURL(file));
  const [error, setError] = useState<string | null>(file.size > MAX_GIF_BYTES ? "Esse GIF passa de 8 MB. Escolha um menor." : null);
  const [busy, setBusy] = useState(false);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onCancel]);

  const label = kind === "avatar" ? "foto de perfil" : "ícone do servidor";
  return (
    <div className="modal-backdrop cropper-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal cropper" role="dialog" aria-label={`GIF animado como ${label}`}>
        <h2>GIF animado</h2>
        <p className="muted small">O GIF fica animado como {label}. Aparece o centro dele, no formato abaixo.</p>
        <div className={`crop-frame ${round ? "round" : ""}`} style={{ width: frameW, height: frameH }}>
          <img src={url} alt="" draggable={false} className="gif-preview" />
        </div>
        <p className="muted small">
          {file.size >= 1024 * 1024
            ? `${(file.size / 1024 / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`
            : `${Math.ceil(file.size / 1024)} KB`}{" "}
          · até 8 MB
        </p>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button className="btn subtle" onClick={onCancel}>
            Cancelar
          </button>
          <button className="btn subtle" onClick={onCropStill} disabled={busy}>
            Recortar como imagem parada
          </button>
          <button
            className="btn primary"
            disabled={busy || file.size > MAX_GIF_BYTES}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onCropped(file);
              } catch (err) {
                setError((err as Error).message);
                setBusy(false);
              }
            }}
          >
            {busy ? "Enviando…" : "Usar GIF animado"}
          </button>
        </div>
      </div>
    </div>
  );
}

function StillCropper({ file, kind, onCancel, onCropped }: Props) {
  const { frameW: FRAME_W, frameH: FRAME_H, outW, outH, round, title, hint } = SHAPES[kind];
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
          className={`crop-frame ${round ? "round" : ""}`}
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
