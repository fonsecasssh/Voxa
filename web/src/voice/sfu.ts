// Calls through a LiveKit media server, when the Voxa server has one (see server/src/livekit.ts).
// Loaded only then: the mesh needs none of this. Each participant's identity is their
// socket id, and a camera or screen track is published under its MediaStream id, so the
// rest of the app finds it exactly as in the mesh (by the ids in the member list).
//
// Like in the mesh, someone's screen share is only received while you watch it.

import { Room, RoomEvent, Track, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication } from "livekit-client";

export type SfuTrackKind = "mic" | "camera" | "screen";

export interface SfuEvents {
  onTrack(identity: string, kind: SfuTrackKind, name: string, track: MediaStreamTrack): void;
  onTrackEnded(identity: string, kind: SfuTrackKind, name: string, track: MediaStreamTrack): void;
  onLeft(identity: string): void;
  onDisconnected(): void;
}

const kindOf = (source: Track.Source): SfuTrackKind =>
  source === Track.Source.Microphone ? "mic" : source === Track.Source.Camera ? "camera" : "screen";

export class SfuLink {
  private watching = new Set<string>();

  private constructor(private room: Room) {}

  static async connect(url: string, token: string, events: SfuEvents): Promise<SfuLink> {
    // Video layers adapt to each viewer; we play audio ourselves (volume, output device).
    const room = new Room({ adaptiveStream: true, dynacast: true });
    const link = new SfuLink(room);
    const wanted = (pub: RemoteTrackPublication, p: RemoteParticipant) => kindOf(pub.source) !== "screen" || link.watching.has(p.identity);

    room
      .on(RoomEvent.TrackPublished, (pub, p) => pub.setSubscribed(wanted(pub, p)))
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub, p) => events.onTrack(p.identity, kindOf(pub.source), pub.trackName, track.mediaStreamTrack))
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, pub, p) =>
        events.onTrackEnded(p.identity, kindOf(pub.source), pub.trackName, track.mediaStreamTrack),
      )
      .on(RoomEvent.ParticipantDisconnected, (p) => events.onLeft(p.identity))
      .on(RoomEvent.Disconnected, () => events.onDisconnected());

    // Fail fast (instead of retrying for a minute) so the user hears about it.
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 20_000));
    try {
      await Promise.race([room.connect(url, token, { autoSubscribe: false, maxRetries: 0, websocketTimeout: 10_000 }), timeout]);
    } catch (err) {
      room.removeAllListeners();
      room.disconnect().catch(() => {});
      throw err;
    }
    // Who was already there.
    for (const p of room.remoteParticipants.values()) for (const pub of p.trackPublications.values()) pub.setSubscribed(wanted(pub, p));
    return link;
  }

  async publishMic(track: MediaStreamTrack) {
    await this.room.localParticipant.publishTrack(track, { source: Track.Source.Microphone, name: "mic", dtx: true, red: true });
  }

  /** A new microphone (device or settings changed), without reconnecting. */
  async replaceMic(track: MediaStreamTrack) {
    const pub = [...this.room.localParticipant.trackPublications.values()].find((p) => p.source === Track.Source.Microphone);
    if (pub?.track) await pub.track.replaceTrack(track, { userProvidedTrack: true });
    else await this.publishMic(track);
  }

  async publishCamera(stream: MediaStream) {
    for (const track of stream.getVideoTracks()) {
      await this.room.localParticipant.publishTrack(track, { source: Track.Source.Camera, name: stream.id, simulcast: true });
    }
  }

  async publishScreen(stream: MediaStream) {
    for (const track of stream.getTracks()) {
      const source = track.kind === "video" ? Track.Source.ScreenShare : Track.Source.ScreenShareAudio;
      await this.room.localParticipant.publishTrack(track, { source, name: stream.id, videoEncoding: { maxBitrate: 2_500_000, maxFramerate: 30 } });
    }
  }

  async unpublish(stream: MediaStream) {
    for (const track of stream.getTracks()) await this.room.localParticipant.unpublishTrack(track, false).catch(() => {});
  }

  /** Starts or stops receiving someone's screen share. */
  setWatching(identity: string, on: boolean) {
    if (on) this.watching.add(identity);
    else this.watching.delete(identity);
    const p = this.room.remoteParticipants.get(identity);
    if (!p) return;
    for (const pub of p.trackPublications.values()) if (kindOf(pub.source) === "screen") pub.setSubscribed(on);
  }

  disconnect() {
    this.room.removeAllListeners();
    this.room.disconnect().catch(() => {});
  }
}
