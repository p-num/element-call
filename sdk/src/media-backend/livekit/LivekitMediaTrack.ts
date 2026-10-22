/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  observeParticipantEvents,
  observeParticipantMedia,
  roomEventSelector,
} from "@livekit/components-core";
import {
  facingModeFromLocalTrack,
  type LocalParticipant,
  LocalTrack,
  LocalVideoTrack,
  type Participant,
  ParticipantEvent,
  RemoteAudioTrack,
  RemoteTrack,
  type Room as LivekitRoom,
  RoomEvent,
  Track,
  TrackEvent,
  type TrackPublication,
} from "livekit-client";
import {
  combineLatest,
  distinctUntilChanged,
  fromEvent,
  map,
  merge,
  type Observable,
  of,
  startWith,
  switchMap,
  timer,
} from "rxjs";

import { type Behavior } from "../../reactive/Behavior";
import { type ObservableScope } from "../../reactive/ObservableScope";
import {
  type AudioMediaTrack,
  type LocalAudioMediaTrack,
  type LocalVideoMediaTrack,
  type MediaSource,
  type MediaStreamStats,
  type MediaTrack,
  type VideoMediaTrack,
} from "../../media-api";
import { MatrixRTCError } from "../../errors";
import { createHandsetPlayback, type HandsetPlayback } from "./HandsetPlayback";
import { convertToLivekitProcessor } from "./videoProcessor";

export const mediaSources: Record<Track.Source, MediaSource> = {
  [Track.Source.Microphone]: "microphone",
  [Track.Source.Camera]: "camera",
  [Track.Source.ScreenShare]: "screenShare",
  [Track.Source.ScreenShareAudio]: "screenShareAudio",
  [Track.Source.Unknown]: "unknown",
};

export const livekitSources: Record<MediaSource, Track.Source> = {
  microphone: Track.Source.Microphone,
  camera: Track.Source.Camera,
  screenShare: Track.Source.ScreenShare,
  screenShareAudio: Track.Source.ScreenShareAudio,
  unknown: Track.Source.Unknown,
};

/**
 * One publication of a participant as a `MediaTrack`. The publication is
 * fixed; the track behind it may come and go (a remote track arrives on
 * subscription), and every attached element follows it.
 */
export function createLivekitMediaTrack(
  scope: ObservableScope,
  participant: Participant,
  publication: TrackPublication,
  room: LivekitRoom,
): AudioMediaTrack | VideoMediaTrack {
  const mediaChanged$ = observeParticipantMedia(participant);
  const track$ = publicationTrack$(scope, participant, publication);

  const attached = new Set<HTMLMediaElement>();
  let audioContext: AudioContext | undefined;
  let audioPlugins: AudioNode[] = [];
  let volume: number | undefined;
  let handset: HandsetPlayback | undefined;
  let current = track$.value;
  const stopHandset = (): void => {
    handset?.stop();
    handset = undefined;
  };
  const applyAudioSettings = (track: Track | undefined): void => {
    if (!(track instanceof RemoteAudioTrack)) return;
    // The handset graph owns playback directly, without a LiveKit HTML anchor.
    // Room.startAudio() can otherwise unmute the anchor and bypass attenuation.
    track.setAudioContext(undefined);
    track.setWebAudioPlugins([]);
    if (volume !== undefined) track.setVolume(volume);
  };
  const attachDirect = (element: HTMLMediaElement): void => {
    current?.attach(element);
    if (current instanceof RemoteAudioTrack) {
      element.muted = false;
      element.volume = volume ?? 1;
    }
  };
  const startPlayback = (): void => {
    if (volume === 0 || attached.size === 0) return;
    if (audioContext && current instanceof RemoteAudioTrack) {
      handset = createHandsetPlayback(
        audioContext,
        current.mediaStreamTrack,
        audioPlugins,
        volume ?? 1,
      );
    } else {
      for (const element of attached) attachDirect(element);
    }
  };

  track$.pipe(scope.bind()).subscribe((track) => {
    stopHandset();
    for (const element of attached) current?.detach(element);
    current = track;
    applyAudioSettings(track);
    startPlayback();
  });
  scope.onEnd(() => {
    stopHandset();
    for (const element of attached) current?.detach(element);
    attached.clear();
  });

  const muted$ = scope.behavior(
    mediaChanged$.pipe(map(() => publication.isMuted)),
    publication.isMuted,
  );
  const base: MediaTrack = {
    source: mediaSources[publication.source],
    kind: publication.kind === Track.Kind.Audio ? "audio" : "video",
    id: publication.trackSid,
    muted$,
    encrypted: publication.isEncrypted,
    stats$: (intervalMs): Observable<MediaStreamStats> =>
      timer(0, intervalMs).pipe(
        switchMap(async () => rtpStreamStats(publication, participant.isLocal)),
        scope.bind(),
      ),
    attach: (element) => {
      if (attached.has(element)) return;
      attached.add(element);
      if (volume === 0) return;
      if (audioContext && current instanceof RemoteAudioTrack) {
        if (!handset) startPlayback();
      } else {
        attachDirect(element);
      }
    },
    detach: (element) => {
      if (!attached.delete(element)) return;
      current?.detach(element);
      if (attached.size === 0) stopHandset();
    },
  };

  if (base.kind === "audio")
    return {
      ...base,
      kind: "audio",
      // LiveKit detects speakers per participant, so this is the member's
      // activity, narrowed to the tracks that can be carrying it
      isActive$: scope.behavior(
        combineLatest(
          [
            observeParticipantEvents(
              participant,
              ParticipantEvent.IsSpeakingChanged,
            ).pipe(map((p) => p.isSpeaking)),
            muted$,
          ],
          (speaking, muted) => speaking && !muted,
        ),
        participant.isSpeaking && !publication.isMuted,
      ),
      // The level has no event of its own: it is written to the participant
      // with each speaker update, which the room announces
      audioLevel$: scope.behavior(
        combineLatest(
          [
            roomEventSelector(room, RoomEvent.ActiveSpeakersChanged).pipe(
              map(() => participant.audioLevel),
              startWith(participant.audioLevel),
            ),
            muted$,
          ],
          (level, muted) => (muted ? 0 : level),
        ),
      ),
      setAudioContext: (ctx, plugins = []) => {
        if (
          audioContext === ctx &&
          audioPlugins.length === plugins.length &&
          audioPlugins.every((node, index) => node === plugins[index])
        )
          return;
        stopHandset();
        for (const element of attached) current?.detach(element);
        audioContext = ctx;
        audioPlugins = plugins;
        applyAudioSettings(current);
        startPlayback();
      },
      setVolume: (v) => {
        const wasMuted = volume === 0;
        volume = v;
        applyAudioSettings(current);
        if (v === 0) {
          stopHandset();
          for (const element of attached) current?.detach(element);
        } else if (handset) {
          handset.setVolume(v);
        } else if (wasMuted) {
          startPlayback();
        } else {
          for (const element of attached) element.volume = v;
        }
      },
    };

  return { ...base, kind: "video" };
}

/**
 * One of our own publications, with the controls over it. `setEnabled` goes
 * through the local member so that what it remembers for a reconnection
 * stays in step.
 */
export function createLocalLivekitMediaTrack(
  scope: ObservableScope,
  participant: LocalParticipant,
  publication: TrackPublication,
  room: LivekitRoom,
  setEnabled: (source: MediaSource, enabled: boolean) => Promise<boolean>,
): LocalAudioMediaTrack | LocalVideoMediaTrack {
  const base = createLivekitMediaTrack(scope, participant, publication, room);
  const local = {
    setEnabled: async (enabled: boolean) => setEnabled(base.source, enabled),
    setDevice: async (deviceId: string): Promise<void> => {
      if (base.source !== "microphone" && base.source !== "camera")
        throw new MatrixRTCError(`A ${base.source} track has no device`);
      await room.switchActiveDevice(
        base.kind === "audio" ? "audioinput" : "videoinput",
        deviceId,
      );
    },
  };
  if (base.kind === "audio") return { ...base, ...local };

  const videoTrack = (): LocalVideoTrack | undefined =>
    publication.track instanceof LocalVideoTrack
      ? publication.track
      : undefined;
  return {
    ...base,
    ...local,
    facingMode$: facingMode$(
      scope,
      publicationTrack$(scope, participant, publication),
    ),
    switchFacingMode: async () => {
      const track = videoTrack();
      if (!track) return;
      const { facingMode } = facingModeFromLocalTrack(track);
      if (facingMode !== "user" && facingMode !== "environment") return;
      await track.restartTrack({
        facingMode: facingMode === "user" ? "environment" : "user",
      });
      return track.mediaStreamTrack.getSettings().deviceId;
    },
    setProcessor: async (processor) => {
      const track = videoTrack();
      // A processor cannot be built on a track that has already ended
      if (!track || track.mediaStreamTrack.readyState === "ended") return;
      if (processor)
        await track.setProcessor(convertToLivekitProcessor(processor));
      else if (track.getProcessor()) await track.stopProcessor();
    },
  };
}

/** The track behind a publication; a remote one arrives on subscription. */
function publicationTrack$(
  scope: ObservableScope,
  participant: Participant,
  publication: TrackPublication,
): Behavior<Track | undefined> {
  return scope.behavior(
    merge(
      observeParticipantMedia(participant),
      fromEvent(publication, TrackEvent.Subscribed),
      fromEvent(publication, TrackEvent.Unsubscribed),
    ).pipe(
      map(() => publication.track),
      startWith(publication.track),
      distinctUntilChanged(),
    ),
  );
}

async function rtpStreamStats(
  publication: TrackPublication,
  local: boolean,
): Promise<MediaStreamStats> {
  const track = publication.track;
  if (!(track instanceof RemoteTrack || track instanceof LocalTrack))
    return undefined;
  const report = await track.getRTCStatsReport();
  if (!report) return undefined;
  const type = local ? "outbound-rtp" : "inbound-rtp";
  for (const stats of report.values()) if (stats.type === type) return stats;
  return undefined;
}

function facingMode$(
  scope: ObservableScope,
  track$: Behavior<Track | undefined>,
): Behavior<"user" | "environment" | undefined> {
  return scope.behavior(
    track$.pipe(
      switchMap((track) => {
        if (!(track instanceof LocalVideoTrack)) return of(undefined);
        return fromEvent(track, TrackEvent.Restarted).pipe(
          startWith(null),
          map(() => {
            const { facingMode } = facingModeFromLocalTrack(track);
            return facingMode === "user" || facingMode === "environment"
              ? facingMode
              : undefined;
          }),
        );
      }),
    ),
  );
}
