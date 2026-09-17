/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  type Participant,
  type RemoteParticipant,
  Track,
} from "livekit-client";
import { BehaviorSubject, type Observable } from "rxjs";

// LiveKit has no volume-change event. Keep the app's requested volume available
// to both HTML playback (LiveKit) and the exclusive handset WebAudio renderer.
// Weak keys keep this state bounded to the lifetime of the participant.
const volumes = new WeakMap<
  Participant,
  Map<Track.Source, BehaviorSubject<number>>
>();

function volumeFor(
  participant: Participant,
  source: Track.Source,
): BehaviorSubject<number> {
  let sources = volumes.get(participant);
  if (!sources) {
    sources = new Map();
    volumes.set(participant, sources);
  }
  let volume = sources.get(source);
  if (!volume) {
    volume = new BehaviorSubject(1);
    sources.set(source, volume);
  }
  return volume;
}

export function setRemoteAudioVolume(
  participant: RemoteParticipant | null,
  volume: number,
  source?: Track.Source.Microphone | Track.Source.ScreenShareAudio,
): void {
  if (!participant) return;
  volumeFor(participant, source ?? Track.Source.Microphone).next(volume);
  if (source === undefined) participant.setVolume(volume);
  else participant.setVolume(volume, source);
}

export function observeRemoteAudioVolume(
  participant: Participant,
  source: Track.Source,
): Observable<number> {
  return volumeFor(participant, source).asObservable();
}
