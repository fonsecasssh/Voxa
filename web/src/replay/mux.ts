// Puts a snapshot's encoded packets into a video file (MP4 or WebM), without re-encoding.
// This module (and Mediabunny with it) is loaded on first use, so it doesn't weigh on the app's startup.

import {
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
} from "mediabunny";
import type { Packet, Snapshot } from "./recorder.ts";

export interface MuxedClip {
  blob: Blob;
  /** Seconds. */
  duration: number;
}

export async function muxClip(s: Snapshot): Promise<MuxedClip> {
  const format = s.container === "mp4" ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new WebMOutputFormat();
  const target = new BufferTarget();
  const output = new Output({ format, target });

  const videoSource = new EncodedVideoPacketSource(s.videoCodec);
  output.addVideoTrack(videoSource, { frameRate: s.fps });
  const withAudio = s.audio.length > 0 && s.audioCodec && s.audioConfig;
  const audioSource = withAudio ? new EncodedAudioPacketSource(s.audioCodec!) : null;
  if (audioSource) output.addAudioTrack(audioSource);
  await output.start();

  const t0 = s.video[0].ts;
  const frame = 1e6 / s.fps;
  // A frame lasts until the next one (the screen may stand still for a while); the last one until the end.
  const videoDur = (i: number) => {
    const next = s.video[i + 1]?.ts ?? s.end;
    return next > s.video[i].ts ? next - s.video[i].ts : frame;
  };
  const packet = (p: Packet, dur: number) => new EncodedPacket(p.data, p.key ? "key" : "delta", (p.ts - t0) / 1e6, dur / 1e6);

  // Interleaved by time, as the file stores them.
  let vi = 0;
  let ai = 0;
  while (vi < s.video.length || (audioSource && ai < s.audio.length)) {
    const takeVideo = !audioSource || ai >= s.audio.length || (vi < s.video.length && s.video[vi].ts <= s.audio[ai].ts);
    if (takeVideo) {
      await videoSource.add(packet(s.video[vi], videoDur(vi)), vi === 0 ? { decoderConfig: s.videoConfig } : undefined);
      vi++;
    } else {
      const a = s.audio[ai];
      await audioSource!.add(packet(a, a.dur || 20_000), ai === 0 ? { decoderConfig: s.audioConfig! } : undefined);
      ai++;
    }
  }
  await output.finalize();

  return { blob: new Blob([target.buffer!], { type: format.mimeType }), duration: (s.end - t0) / 1e6 };
}
