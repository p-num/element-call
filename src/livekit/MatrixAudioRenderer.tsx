/*
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { getTrackReferenceId } from "@livekit/components-core";
import { RoomEvent, Track, type Room as LivekitRoom } from "livekit-client";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTracks } from "@livekit/components-react";
import { logger as rootLogger } from "matrix-js-sdk/lib/logger";

import { useObservableEagerState } from "observable-hooks";
import { getUrlParams } from "../UrlParams";
import { supportsWebKitAudioOutput } from "../routeAudioOutput";
import {
  useMediaDevices,
  useEarpieceAudioConfig,
} from "../MediaDevicesContext";
import * as controls from "../controls";
import {
  RemoteAudioPlayback,
  type RemoteAudioOutput,
} from "./RemoteAudioPlayback";

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
 * Routes to browser output devices when WebKit supports selection, retaining
 * the legacy WebAudio earpiece approximation on older iOS versions.
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
      // A publication can replace its track without changing subscription status.
      updateOnlyOn: [RoomEvent.TrackSubscribed, RoomEvent.TrackUnsubscribed],
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

  const selectedOutput = useObservableEagerState(
    useMediaDevices().audioOutput.selected$,
  );
  const { controlledAudioDevices } = getUrlParams();
  const awaitingOutput =
    controlledAudioDevices && supportsWebKitAudioOutput() && !selectedOutput;
  const sinkId = selectedOutput?.sinkId;
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

  // Do not mount either playback path until the handset context is ready.
  const output = useMemo<RemoteAudioOutput | null>(() => {
    if (awaitingOutput) return null;
    if (!useEarpiece) return { type: "html", sinkId };
    if (!audioContext) return null;
    return { type: "earpiece", context: audioContext, pan, volume };
  }, [useEarpiece, audioContext, pan, volume, sinkId, awaitingOutput]);

  return (
    <div style={{ display: "none" }}>
      {output &&
        tracks.map((trackRef) => (
          <RemoteAudioPlayback
            key={`${getTrackReferenceId(trackRef)}:${sinkId ?? "native"}`}
            trackRef={trackRef}
            output={output}
            muted={muted}
          />
        ))}
    </div>
  );
}
