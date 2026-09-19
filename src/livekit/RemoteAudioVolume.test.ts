/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { test } from "vitest";
import { Track } from "livekit-client";

import { mockRemoteParticipant, withTestScheduler } from "../utils/test";
import {
  observeRemoteAudioVolume,
  setRemoteAudioVolume,
} from "./RemoteAudioVolume";

test("a renderer mounted after muting receives zero immediately", () => {
  const participant = mockRemoteParticipant({});
  setRemoteAudioVolume(participant, 0);
  withTestScheduler(({ expectObservable }) => {
    expectObservable(
      observeRemoteAudioVolume(participant, Track.Source.Microphone),
    ).toBe("a", { a: 0 });
  });
});

test("volume is isolated by participant and track source", () => {
  const participant = mockRemoteParticipant({});
  const otherParticipant = mockRemoteParticipant({});
  withTestScheduler(({ expectObservable, schedule }) => {
    schedule("-ab", {
      a: () => setRemoteAudioVolume(participant, 0.4),
      b: () =>
        setRemoteAudioVolume(participant, 0.2, Track.Source.ScreenShareAudio),
    });
    expectObservable(
      observeRemoteAudioVolume(participant, Track.Source.Microphone),
    ).toBe("ab", { a: 1, b: 0.4 });
    expectObservable(
      observeRemoteAudioVolume(participant, Track.Source.ScreenShareAudio),
    ).toBe("a-b", { a: 1, b: 0.2 });
    expectObservable(
      observeRemoteAudioVolume(participant, Track.Source.Unknown),
    ).toBe("a", { a: 1 });
    expectObservable(
      observeRemoteAudioVolume(otherParticipant, Track.Source.Microphone),
    ).toBe("a", { a: 1 });
  });
});
