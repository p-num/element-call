/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type Participant, Track } from "livekit-client";
import { BehaviorSubject, type Observable } from "rxjs";

// The app owns requested volume; each renderer applies it to its playback path.
// Keeping this state independent of LiveKit also preserves zero volume when an
// HTML audio element is reattached, which LiveKit does not restore itself.
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
  participant: Participant | null,
  volume: number,
  source: Track.Source.Microphone | Track.Source.ScreenShareAudio = Track.Source
    .Microphone,
): void {
  if (!participant) return;
  volumeFor(participant, source).next(volume);
}

export function observeRemoteAudioVolume(
  participant: Participant,
  source: Track.Source,
): Observable<number> {
  return volumeFor(participant, source).asObservable();
}
