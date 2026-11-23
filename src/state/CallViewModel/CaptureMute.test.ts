/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";
import { BehaviorSubject } from "rxjs";
import { createClient } from "matrix-js-sdk";
import {
  type LocalAudioMediaTrack,
  type LocalVideoMediaTrack,
} from "@element-hq/matrixrtc-sdk";

import { createCallViewModel$ } from "./CallViewModel";
import { MuteStates } from "../MuteStates";
import { type DeviceLabel } from "../MediaDevices";
import { constant } from "../Behavior";
import { nullHostBridge } from "../../HostBridge";
import { E2eeType } from "../../e2ee/e2eeType";
import {
  flushPromises,
  mockAudioTrack,
  mockConfig,
  mockMatrixRoom,
  mockMediaDevices,
  mockRTCMember,
  mockRTCParticipation,
  mockVideoTrack,
  testScope,
} from "../../utils/test";
import { localRtcMember } from "../../utils/test-fixtures";

mockConfig({});

describe.each(["microphone", "camera"] as const)(
  "%s mute binding",
  (source) => {
    it("allows the published track to arrive before enable settles", async () => {
      const call = captureCall(source);
      const publication = Promise.withResolvers<typeof call.track>();
      vi.mocked(call.participation.publish).mockImplementation(async () => {
        call.tracks$.next([call.track]);
        return publication.promise;
      });

      call.mute.setEnabled$.value?.(true);
      expect(call.mute.enabled$.value).toBe(false);
      expect(call.track.setEnabled).not.toHaveBeenCalled();
      publication.resolve(call.track);
      await flushPromises();
      expect(call.mute.enabled$.value).toBe(true);
      expect(call.track.setEnabled).not.toHaveBeenCalled();
    });

    it("mutes tracks arriving after publication is refused", async () => {
      const call = captureCall(source);
      vi.mocked(call.participation.publish).mockRejectedValue(
        new Error("Capture permission denied"),
      );
      call.mute.setEnabled$.value?.(true);
      await flushPromises();

      call.tracks$.next([call.track]);
      await flushPromises();
      expect(call.track.setEnabled).toHaveBeenCalledExactlyOnceWith(false);
      expect(call.mute.enabled$.value).toBe(false);
    });

    it("keeps a pending enable valid across queued off and on choices", async () => {
      const call = captureCall(source);
      const publication = Promise.withResolvers<typeof call.track>();
      vi.mocked(call.participation.publish).mockReturnValue(
        publication.promise,
      );
      call.mute.setEnabled$.value?.(true);
      call.mute.setEnabled$.value?.(false);
      call.tracks$.next([call.track]);
      call.mute.setEnabled$.value?.(true);
      publication.resolve(call.track);
      await flushPromises();

      expect(call.track.setEnabled).not.toHaveBeenCalled();
      expect(call.mute.enabled$.value).toBe(true);
      expect(call.mute.syncing$.value).toBe(false);
    });

    it("applies a queued off choice after the pending publication settles", async () => {
      const call = captureCall(source);
      const publication = Promise.withResolvers<typeof call.track>();
      vi.mocked(call.participation.publish).mockReturnValue(
        publication.promise,
      );
      call.mute.setEnabled$.value?.(true);
      call.mute.setEnabled$.value?.(false);
      call.tracks$.next([call.track]);
      publication.resolve(call.track);
      await flushPromises();

      expect(call.track.setEnabled).toHaveBeenCalledExactlyOnceWith(false);
      expect(call.mute.enabled$.value).toBe(false);
      expect(call.mute.syncing$.value).toBe(false);
    });

    it("keeps an initially muted source off when its track arrives", async () => {
      const call = captureCall(source);
      call.tracks$.next([call.track]);
      await flushPromises();
      expect(call.track.setEnabled).toHaveBeenCalledExactlyOnceWith(false);
      expect(call.participation.publish).not.toHaveBeenCalled();
      expect(call.mute.enabled$.value).toBe(false);
    });

    it("mutes an arriving track immediately after its input becomes unavailable", async () => {
      const call = captureCall(source);
      const publication = Promise.withResolvers<typeof call.track>();
      vi.mocked(call.participation.publish).mockReturnValue(
        publication.promise,
      );
      call.mute.setEnabled$.value?.(true);
      call.available$.next(new Map());
      call.tracks$.next([call.track]);
      expect(call.track.setEnabled).toHaveBeenCalledExactlyOnceWith(false);

      publication.resolve(call.track);
      await flushPromises();
      expect(call.mute.enabled$.value).toBe(false);
      expect(call.mute.setEnabled$.value).toBeNull();
    });
  },
);

function captureCall(source: "microphone" | "camera") {
  const scope = testScope();
  const available$ = new BehaviorSubject(
    new Map<string, DeviceLabel>([["input", { type: "name", name: "Input" }]]),
  );
  const input = { available$, selected$: constant(undefined), select: vi.fn() };
  const mediaDevices = mockMediaDevices({
    audioInput: input,
    videoInput: input,
  });
  const muteStates = new MuteStates(
    scope,
    mediaDevices,
    { audioEnabled: false, videoEnabled: false },
    nullHostBridge,
  );
  const tracks$ = new BehaviorSubject<
    (LocalAudioMediaTrack | LocalVideoMediaTrack)[]
  >([]);
  const participation = mockRTCParticipation(scope, {
    localMember$: constant(
      mockRTCMember(true, { membership: localRtcMember, tracks$ }),
    ),
  });
  const client = createClient({
    baseUrl: "https://example.org",
    userId: localRtcMember.userId,
    deviceId: localRtcMember.deviceId,
  });
  createCallViewModel$(
    scope,
    participation,
    mockMatrixRoom({ client, getMembersWithMembership: () => [] }),
    mediaDevices,
    muteStates,
    {
      encryptionSystem: { kind: E2eeType.PER_PARTICIPANT },
      windowSize$: constant({ width: 1000, height: 800 }),
    },
    constant({}),
    constant({}),
  );
  return {
    mute: source === "microphone" ? muteStates.audio : muteStates.video,
    track: source === "microphone" ? mockAudioTrack() : mockVideoTrack(),
    participation,
    tracks$,
    available$,
  };
}
