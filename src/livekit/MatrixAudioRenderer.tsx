/*
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  getTrackReferenceId,
  type TrackReference,
} from "@livekit/components-core";
import { type Room as LivekitRoom } from "livekit-client";
import {
  RemoteAudioTrack,
  RemoteTrackPublication,
  Track,
} from "livekit-client";
import { useEffect, useState, type ReactNode } from "react";
import { useTracks, AudioTrack } from "@livekit/components-react";
import { logger as rootLogger } from "matrix-js-sdk/lib/logger";

import { useEarpieceAudioConfig } from "../MediaDevicesContext";
import * as controls from "../controls";
import { observeRemoteAudioVolume } from "./RemoteAudioVolume";

export interface MatrixAudioRendererProps {
  /**
   * The service URL of the LiveKit room.
   */
  url: string;
  livekitRoom: LivekitRoom;
  /**
   * The list of participant identities to render audio for.
   * This list needs to be composed based on the matrixRTC members so that we do not play audio from users
   * that are not expected to be in the rtc session (local user is excluded).
   */
  validIdentities: string[];
  /**
   * If set to `true`, mutes all audio tracks rendered by the component.
   * @remarks
   * If set to `true`, the server will stop sending audio track data to the client.
   */
  muted?: boolean;
}

/**
 * Takes care of handling remote participants’ audio tracks and makes sure that microphones and screen share are audible.
 *
 * It also takes care of the earpiece audio configuration for iOS devices.
 * This is done by using the WebAudio API to create a stereo pan effect that mimics the earpiece audio.
 * @example
 * ```tsx
 * <LiveKitRoom>
 *   <MatrixAudioRenderer />
 * </LiveKitRoom>
 * ```
 * @public
 */
export function LivekitRoomAudioRenderer({
  url,
  livekitRoom,
  validIdentities,
  muted,
}: MatrixAudioRendererProps): ReactNode {
  const logger = rootLogger.getChild("[MatrixAudioRenderer]");
  const tracks = useTracks(
    [
      Track.Source.Microphone,
      Track.Source.ScreenShareAudio,
      Track.Source.Unknown,
    ],
    {
      updateOnlyOn: [],
      onlySubscribed: true,
      room: livekitRoom,
    },
  )
    // Only keep audio tracks
    .filter((ref) => ref.publication.kind === Track.Kind.Audio)
    // Only keep tracks from participants that are in the validIdentities list
    .filter((ref) => {
      const isValid = validIdentities.includes(ref.participant.identity);
      if (!isValid) {
        // TODO make sure to also skip the warn logging for the local identity
        // Log that there is an invalid identity, that means that someone is publishing audio that is not expected to be in the call.
        logger.warn(
          `Audio track ${ref.participant.identity} from ${url} has no matching matrix call member`,
          `current members: ${validIdentities.join()}`,
          `track will not get rendered`,
        );
        return false;
      }
      return true;
    });

  const { pan, volume } = useEarpieceAudioConfig();
  const useEarpiece = pan !== 0;
  const [audioContext, setAudioContext] = useState<AudioContext>();

  useEffect(() => {
    if (!useEarpiece) return;
    const logger = rootLogger.getChild("[MatrixAudioRenderer]");
    const context = new AudioContext();
    setAudioContext(context);
    const resume = (): void => {
      if (!document.hidden && context.state !== "running") {
        void context.resume().catch((error) => {
          logger.warn("Unable to resume handset audio", error);
        });
      }
    };
    document.addEventListener("visibilitychange", resume);
    return (): void => {
      document.removeEventListener("visibilitychange", resume);
      setAudioContext(undefined);
      void context.close().catch((error) => {
        logger.warn("Unable to close handset audio", error);
      });
    };
  }, [useEarpiece]);

  useEffect(() => {
    if (tracks.length > 0) controls.setPlaybackStarted();
  }, [tracks.length]);

  return (
    <div style={{ display: "none" }}>
      {tracks.map((trackRef) =>
        useEarpiece ? (
          <EarpieceAudioTrack
            key={getTrackReferenceId(trackRef)}
            trackRef={trackRef}
            audioContext={audioContext}
            pan={pan}
            volume={volume}
            muted={muted}
          />
        ) : (
          // Keep HTML playback for speaker/headsets: WebAudio can be suspended
          // in standby on iOS (WebKit #251532).
          <AudioTrack
            key={getTrackReferenceId(trackRef)}
            trackRef={trackRef}
            muted={muted}
          />
        ),
      )}
    </div>
  );
}

/**
 * Own handset playback exclusively. Attaching an HTML audio element as well
 * lets LiveKit.startAudio or React unmute a full-volume path on iOS, where
 * HTMLMediaElement.volume cannot attenuate playback.
 */
function EarpieceAudioTrack({
  trackRef,
  audioContext,
  pan,
  volume,
  muted,
}: {
  trackRef: TrackReference;
  audioContext?: AudioContext;
  pan: number;
  volume: number;
  muted?: boolean;
}): ReactNode {
  const publication = trackRef.publication;
  const track = publication.track;
  const { participant, source: trackSource } = trackRef;

  useEffect(() => {
    if (publication instanceof RemoteTrackPublication && muted !== undefined) {
      publication.setEnabled(!muted);
    }
  }, [publication, muted]);

  useEffect(() => {
    if (!audioContext || !(track instanceof RemoteAudioTrack) || muted) return;
    const source = audioContext.createMediaStreamSource(
      new MediaStream([track.mediaStreamTrack]),
    );
    const gain = audioContext.createGain();
    const panner = audioContext.createStereoPanner();
    const volumeSubscription = observeRemoteAudioVolume(
      participant,
      trackSource,
    ).subscribe((requestedVolume) => {
      gain.gain.value = volume * requestedVolume;
    });
    panner.pan.value = pan;
    source.connect(gain).connect(panner).connect(audioContext.destination);
    void audioContext.resume().catch((error) => {
      rootLogger
        .getChild("[MatrixAudioRenderer]")
        .warn("Unable to start handset audio", error);
    });
    return (): void => {
      volumeSubscription.unsubscribe();
      source.disconnect();
      gain.disconnect();
      panner.disconnect();
    };
  }, [audioContext, track, participant, trackSource, pan, volume, muted]);

  return null;
}
