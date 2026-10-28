// Records a screen (and its audio) into a rolling buffer of encoded video, like a DVR:
// frames are encoded as they arrive (WebCodecs, hardware H.264 when available) and only the
// last `maxSeconds` are kept. Saving a clip later needs no re-encoding: the packets since the
// right keyframe are just put in a file (see mux.ts).

type VideoCodecName = "avc" | "vp9" | "vp8";
type AudioCodecName = "aac" | "opus";

/** A frame or chunk of audio, already encoded. Times are in microseconds since the recording started. */
export interface Packet {
  data: Uint8Array;
  key: boolean;
  ts: number;
  dur: number;
}

/** The packets for one clip, plus what's needed to put them in a file. */
export interface Snapshot {
  container: "mp4" | "webm";
  width: number;
  height: number;
  fps: number;
  video: Packet[];
  videoCodec: VideoCodecName;
  videoConfig: VideoDecoderConfig;
  audio: Packet[];
  audioCodec: AudioCodecName | null;
  audioConfig: AudioDecoderConfig | null;
  /** End of the clip (µs), so the last frame lasts until then even if the screen stood still. */
  end: number;
}

export interface RecorderOptions {
  maxSeconds: number;
  height: number;
  fps: number;
  bitrate: number;
}

// Not in TypeScript's DOM types yet (Chromium only, which is what the desktop app runs).
declare const MediaStreamTrackProcessor: {
  new <T>(init: { track: MediaStreamTrack; maxBufferSize?: number }): { readable: ReadableStream<T> };
};

export const canRecordReplay = () =>
  typeof VideoEncoder !== "undefined" && typeof MediaStreamTrackProcessor !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;

/** A keyframe every 2 s: a clip starts at most this much earlier than asked. */
const KEYFRAME_EVERY_US = 2_000_000;
/** Extra history kept beyond maxSeconds, so a clip can always start on a keyframe. */
const SLACK_US = KEYFRAME_EVERY_US + 1_000_000;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

async function pickVideoEncoder(width: number, height: number, fps: number, bitrate: number) {
  const level = width * height > 1280 * 720 ? (fps > 30 ? "2a" : "28") : "1f"; // H.264 High at level 4.2 / 4.0 / 3.1
  const candidates: { name: VideoCodecName; codec: string; extra?: Partial<VideoEncoderConfig> }[] = [
    { name: "avc", codec: `avc1.6400${level}`, extra: { avc: { format: "avc" } } },
    { name: "vp9", codec: "vp09.00.40.08" },
    { name: "vp8", codec: "vp8" },
  ];
  for (const c of candidates) {
    for (const hardwareAcceleration of ["prefer-hardware", "no-preference"] as const) {
      const config: VideoEncoderConfig = { codec: c.codec, width, height, bitrate, framerate: fps, hardwareAcceleration, ...c.extra };
      const r = await VideoEncoder.isConfigSupported(config).catch(() => null);
      if (r?.supported) return { name: c.name, config };
    }
  }
  return null;
}

async function pickAudioEncoder(container: "mp4" | "webm", sampleRate: number, numberOfChannels: number) {
  // AAC plays everywhere in an MP4 (WhatsApp, phones...); Opus is the fallback, and WebM's only option.
  const candidates: { name: AudioCodecName; codec: string }[] = [
    ...(container === "mp4" ? [{ name: "aac" as const, codec: "mp4a.40.2" }] : []),
    { name: "opus", codec: "opus" },
  ];
  for (const c of candidates) {
    const config: AudioEncoderConfig = { codec: c.codec, sampleRate, numberOfChannels, bitrate: 160_000 };
    const r = await AudioEncoder.isConfigSupported(config).catch(() => null);
    if (r?.supported) return { name: c.name, config };
  }
  return null;
}

export class ReplayRecorder {
  maxSeconds: number;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly container: "mp4" | "webm";
  /** Called once if recording stops by itself (capture ended, encoder failed). */
  onStop: ((error: string | null) => void) | null = null;

  private video: Packet[] = [];
  private audio: Packet[] = [];
  private videoConfig: VideoDecoderConfig | null = null;
  private audioConfig: AudioDecoderConfig | null = null;
  private audioCodec: AudioCodecName | null = null;
  private readonly videoCodec: VideoCodecName;
  private readonly videoEncoder: VideoEncoder;
  private audioEncoder: AudioEncoder | null = null;
  private readers: ReadableStreamDefaultReader<unknown>[] = [];
  private stopped = false;
  private readonly t0 = performance.now() * 1000;
  /** Raw capture timestamps -> our clock, per track (their origins may differ). */
  private offsets: { video?: number; audio?: number } = {};
  private canvas: OffscreenCanvas | null = null;

  private constructor(
    private readonly stream: MediaStream,
    opts: RecorderOptions,
    size: { width: number; height: number },
    encoder: { name: VideoCodecName; config: VideoEncoderConfig },
  ) {
    this.maxSeconds = opts.maxSeconds;
    this.width = size.width;
    this.height = size.height;
    this.fps = opts.fps;
    this.videoCodec = encoder.name;
    this.container = encoder.name === "avc" ? "mp4" : "webm";
    this.videoEncoder = new VideoEncoder({
      output: (chunk, meta) => this.onVideoChunk(chunk, meta),
      error: (e) => this.fail(`O codificador de vídeo falhou (${e.message}).`),
    });
    this.videoEncoder.configure(encoder.config);
  }

  /** Starts recording `stream` (its video track and, if any, its audio track). */
  static async start(stream: MediaStream, opts: RecorderOptions): Promise<ReplayRecorder> {
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error("A captura não tem vídeo.");
    const s = track.getSettings();
    const scale = Math.min(1, opts.height / (s.height || opts.height));
    const size = { width: even((s.width || (opts.height * 16) / 9) * scale), height: even((s.height || opts.height) * scale) };
    const encoder = await pickVideoEncoder(size.width, size.height, opts.fps, opts.bitrate);
    if (!encoder) throw new Error("Este computador não consegue codificar vídeo para o replay.");
    const rec = new ReplayRecorder(stream, opts, size, encoder);
    rec.pumpVideo(track);
    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) rec.pumpAudio(audioTrack);
    track.addEventListener("ended", () => rec.fail(null));
    return rec;
  }

  /** Seconds of history currently available. */
  get bufferedSeconds(): number {
    if (this.video.length === 0) return 0;
    return Math.min(this.maxSeconds, (this.now() - this.video[0].ts) / 1e6);
  }

  get hasAudio(): boolean {
    return this.audio.length > 0;
  }

  /** The last `seconds` (from the keyframe at or just before), ready to be muxed. */
  snapshot(seconds: number): Snapshot | null {
    const v = this.video;
    if (v.length === 0 || !this.videoConfig) return null;
    const end = Math.max(this.now(), v.at(-1)!.ts + 1);
    const want = end - seconds * 1e6;
    let start = 0;
    for (let i = 0; i < v.length && v[i].ts <= want; i++) if (v[i].key) start = i;
    const video = v.slice(start);
    const from = video[0].ts;
    return {
      container: this.container,
      width: this.width,
      height: this.height,
      fps: this.fps,
      video,
      videoCodec: this.videoCodec,
      videoConfig: this.videoConfig,
      audio: this.audioConfig ? this.audio.filter((a) => a.ts >= from && a.ts < end) : [],
      audioCodec: this.audioConfig ? this.audioCodec : null,
      audioConfig: this.audioConfig,
      end,
    };
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const r of this.readers) r.cancel().catch(() => {});
    for (const enc of [this.videoEncoder, this.audioEncoder]) {
      if (enc && enc.state !== "closed") enc.close();
    }
    for (const t of this.stream.getTracks()) t.stop();
    this.video = [];
    this.audio = [];
  }

  // --- internals -----------------------------------------------------------------------

  private now() {
    return performance.now() * 1000 - this.t0;
  }

  private fail(error: string | null) {
    if (this.stopped) return;
    this.stop();
    this.onStop?.(error);
  }

  /** Maps a capture timestamp to our clock; the first one of each track anchors it to "now". */
  private clock(kind: "video" | "audio", raw: number) {
    this.offsets[kind] ??= this.now() - raw;
    return raw + this.offsets[kind]!;
  }

  private async pumpVideo(track: MediaStreamTrack) {
    const reader = new MediaStreamTrackProcessor<VideoFrame>({ track }).readable.getReader();
    this.readers.push(reader);
    const minGap = (1e6 / this.fps) * 0.85;
    let last = -Infinity;
    let lastKey = -Infinity;
    try {
      for (;;) {
        const { value: frame, done } = await reader.read();
        if (done || this.stopped) {
          frame?.close();
          break;
        }
        this.clock("video", frame.timestamp); // anchors the clock on arrival, not after encoding
        // Keep to the chosen frame rate, and drop frames rather than fall behind.
        if (frame.timestamp - last < minGap || this.videoEncoder.encodeQueueSize > 4) {
          frame.close();
          continue;
        }
        last = frame.timestamp;
        const keyFrame = frame.timestamp - lastKey >= KEYFRAME_EVERY_US;
        if (keyFrame) lastKey = frame.timestamp;
        const input = frame.displayWidth === this.width && frame.displayHeight === this.height ? frame : this.fit(frame);
        this.videoEncoder.encode(input, { keyFrame });
        input.close();
        if (input !== frame) frame.close();
      }
    } catch (err) {
      this.fail(`A captura de vídeo parou (${(err as Error).message}).`);
    }
  }

  /** Scales a frame of another size (e.g. a window that was resized) into ours, letterboxed. */
  private fit(frame: VideoFrame): VideoFrame {
    this.canvas ??= new OffscreenCanvas(this.width, this.height);
    const ctx = this.canvas.getContext("2d")!;
    const scale = Math.min(this.width / frame.displayWidth, this.height / frame.displayHeight);
    const w = frame.displayWidth * scale;
    const h = frame.displayHeight * scale;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.drawImage(frame, (this.width - w) / 2, (this.height - h) / 2, w, h);
    return new VideoFrame(this.canvas, { timestamp: frame.timestamp });
  }

  private onVideoChunk(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) {
    if (this.stopped) return;
    if (meta?.decoderConfig) this.videoConfig = meta.decoderConfig;
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const ts = this.clock("video", chunk.timestamp);
    this.video.push({ data, key: chunk.type === "key", ts, dur: chunk.duration ?? 0 });
    if (chunk.type === "key") this.trim(ts);
  }

  /** Forgets what's older than the window, always keeping a keyframe to start from. */
  private trim(now: number) {
    const cutoff = now - this.maxSeconds * 1e6 - SLACK_US;
    let drop = 0;
    for (let i = 0; i < this.video.length && this.video[i].ts <= cutoff; i++) if (this.video[i].key) drop = i;
    if (drop > 0) this.video.splice(0, drop);
    const first = this.video[0]?.ts ?? now;
    let a = 0;
    while (a < this.audio.length && this.audio[a].ts < first) a++;
    if (a > 0) this.audio.splice(0, a);
  }

  private async pumpAudio(track: MediaStreamTrack) {
    const reader = new MediaStreamTrackProcessor<AudioData>({ track }).readable.getReader();
    this.readers.push(reader);
    try {
      for (;;) {
        const { value: data, done } = await reader.read();
        if (done || this.stopped) {
          data?.close();
          break;
        }
        this.clock("audio", data.timestamp);
        if (!this.audioEncoder) {
          const picked = data.numberOfChannels <= 2 ? await pickAudioEncoder(this.container, data.sampleRate, data.numberOfChannels) : null;
          if (!picked || this.stopped) {
            // No usable audio encoder: the clips just have no sound.
            data.close();
            break;
          }
          this.audioCodec = picked.name;
          this.audioEncoder = new AudioEncoder({
            output: (chunk, meta) => this.onAudioChunk(chunk, meta),
            error: () => {
              // Keep recording the picture; only the sound is lost.
              this.audioConfig = null;
            },
          });
          this.audioEncoder.configure(picked.config);
        }
        if (this.audioEncoder.state === "configured" && this.audioEncoder.encodeQueueSize < 20) this.audioEncoder.encode(data);
        data.close();
      }
    } catch {
      // Audio capture stopped; the picture keeps recording.
    }
  }

  private onAudioChunk(chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) {
    if (this.stopped) return;
    if (meta?.decoderConfig) this.audioConfig = meta.decoderConfig;
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.audio.push({ data, key: true, ts: this.clock("audio", chunk.timestamp), dur: chunk.duration ?? 0 });
  }
}
