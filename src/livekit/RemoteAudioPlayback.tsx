/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type TrackReference } from "@livekit/components-core";
import { RemoteAudioTrack, RemoteTrackPublication } from "livekit-client";
import { logger } from "matrix-js-sdk/lib/logger";
import { useObservableEagerState } from "observable-hooks";
import { useEffect, useMemo, useRef, type ReactNode } from "react";

import { observeRemoteAudioVolume } from "./RemoteAudioVolume";

export type RemoteAudioOutput =
  | { type: "html" }
  | { type: "earpiece"; context: AudioContext; pan: number; volume: number };

/**
 * Applies the same requested volume and mute policy to both playback paths.
 * The handset graph must never have a parallel HTML audio element: LiveKit can
 * unmute that element on restart, bypassing attenuation on iOS.
 */
export function RemoteAudioPlayback({
  trackRef,
  output,
  muted = false,
}: {
  trackRef: TrackReference;
  output: RemoteAudioOutput;
  muted?: boolean;
}): ReactNode {
  const { participant, source: trackSource, publication } = trackRef;
  const track = publication.track;
  const audioElement = useRef<HTMLAudioElement>(null);
  const volume$ = useMemo(
    () => observeRemoteAudioVolume(participant, trackSource),
    [participant, trackSource],
  );
  const requestedVolume = useObservableEagerState(volume$);
  const playbackMuted = muted || requestedVolume === 0;

  useEffect(() => {
    if (publication instanceof RemoteTrackPublication) {
      publication.setEnabled(!playbackMuted);
    }
  }, [publication, playbackMuted]);

  useEffect(() => {
    if (!(track instanceof RemoteAudioTrack) || playbackMuted) return;
    if (output.type === "html") {
      const element = audioElement.current;
      if (!element) return;
      // Attach the exact track selected by useTracks. The SDK React AudioTrack
      // hook caches its own track and misses replacements on a publication whose
      // subscription status stays unchanged.
      const subscription = volume$.subscribe((volume) =>
        track.setVolume(volume),
      );
      track.attach(element);
      return (): void => {
        subscription.unsubscribe();
        track.detach(element);
      };
    }
    const { context, pan, volume } = output;
    const source = context.createMediaStreamSource(
      new MediaStream([track.mediaStreamTrack]),
    );
    const gain = context.createGain();
    const panner = context.createStereoPanner();
    const volumeSubscription = volume$.subscribe((requestedVolume) => {
      gain.gain.value = volume * requestedVolume;
    });
    panner.pan.value = pan;
    source.connect(gain).connect(panner).connect(context.destination);
    void context.resume().catch((error) => {
      logger
        .getChild("[MatrixAudioRenderer]")
        .warn("Unable to start handset audio", error);
    });
    return (): void => {
      volumeSubscription.unsubscribe();
      source.disconnect();
      gain.disconnect();
      panner.disconnect();
    };
  }, [output, track, volume$, playbackMuted]);

  // iOS ignores HTML volume. Detaching muted playback also prevents startAudio
  // from reviving it while the server processes the publication disable request.
  if (playbackMuted || output.type === "earpiece") return null;

  // Keep HTML playback for speaker/headsets: WebAudio can be suspended in
  // standby on iOS (WebKit #251532). Always supply volume, including on mount
  // and track replacement, rather than relying on LiveKit's cached value.
  // Live call audio has no prerecorded caption track.
  // oxlint-disable-next-line jsx-a11y/media-has-caption
  return <audio ref={audioElement} />;
}
