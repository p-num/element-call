/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalVideoTrack, Room, Track, TrackEvent } from "livekit-client";
import { Capture, Stream, sender } from "./capture-fixture.mjs";

let camera, raw, primary, backup;
beforeEach(async () => {
  vi.stubGlobal("MediaStream", Stream);
  vi.stubGlobal("navigator", { userAgent: "Mobile" });
  raw = new Capture("video", { width: 640, height: 360 });
  primary = sender();
  backup = sender();
  camera = new LocalVideoTrack(raw, {}, false);
  camera.source = Track.Source.Camera;
  await new Promise((resolve) => setTimeout(resolve, 0));
  camera.sender = primary;
  camera.addSimulcastTrack("h264").sender = backup;
  vi.useFakeTimers();
});
afterEach(() => {
  camera.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["caller first", "browser first"])(
  "requires both pause owners to resume (%s)",
  async (order) => {
    const resumed = vi.fn();
    camera.on(TrackEvent.UpstreamResumed, resumed);
    if (order === "caller first") await camera.pauseUpstream();
    raw.dispatchEvent(new Event("mute"));
    await vi.advanceTimersByTimeAsync(5000);
    if (order === "browser first") await camera.pauseUpstream();
    primary.replaceTrack.mockClear();
    backup.replaceTrack.mockClear();
    raw.dispatchEvent(new Event("unmute"));
    await vi.advanceTimersByTimeAsync(0);
    expect(camera.isUpstreamPaused).toBe(true);
    expect(resumed).not.toHaveBeenCalled();
    expect(primary.replaceTrack).not.toHaveBeenCalled();
    expect(backup.replaceTrack).not.toHaveBeenCalled();
    await camera.resumeUpstream();
    expect(resumed).toHaveBeenCalledOnce();
    expect(primary.replaceTrack).toHaveBeenCalledWith(raw);
    expect(backup.replaceTrack).toHaveBeenCalledWith(
      camera.simulcastCodecs.get("h264").mediaStreamTrack,
    );
  },
);

it.each([true, false])(
  "keeps each sender detached only while the caller holds it (%s)",
  async (callerPaused) => {
    const acquisition = Promise.withResolvers();
    const requested = Promise.withResolvers();
    vi.stubGlobal("navigator", {
      userAgent: "Mobile",
      mediaDevices: {
        getUserMedia: () => {
          requested.resolve();
          return acquisition.promise;
        },
      },
    });
    raw.dispatchEvent(new Event("mute"));
    await vi.advanceTimersByTimeAsync(5000);
    const restarted = camera.restartTrack();
    await requested.promise;
    if (callerPaused) await camera.pauseUpstream();
    primary.replaceTrack.mockClear();
    backup.replaceTrack.mockClear();
    const replacement = raw.clone();
    acquisition.resolve(new Stream([replacement]));
    await restarted;
    expect(camera.mediaStreamTrack).toBe(replacement);
    expect(camera.isUpstreamPaused).toBe(callerPaused);
    for (const rtcSender of [primary, backup]) {
      const bound = rtcSender.replaceTrack.mock.calls.filter(
        ([track]) => track !== null,
      );
      expect(bound.length > 0).toBe(!callerPaused);
    }
    if (callerPaused) {
      await camera.resumeUpstream();
      expect(primary.replaceTrack).toHaveBeenCalledWith(replacement);
      expect(backup.replaceTrack).toHaveBeenCalledWith(
        camera.simulcastCodecs.get("h264").mediaStreamTrack,
      );
    }
  },
);

it("negotiates a backup sender detached under a caller hold", async () => {
  const engine = new Room().engine;
  const late = sender();
  const pc = {
    addPublisherTransceiver: vi.fn().mockResolvedValue({ sender: late }),
    addPublisherTransceiverOfKind: vi.fn().mockResolvedValue({ sender: late }),
  };
  engine.pcManager = pc;
  const sc = camera.addSimulcastTrack("vp8");
  await camera.pauseUpstream();
  await engine.createSimulcastTransceiverSender(
    camera,
    sc,
    { videoCodec: "vp8" },
    [],
  );
  expect(pc.addPublisherTransceiver).not.toHaveBeenCalled();
  expect(pc.addPublisherTransceiverOfKind).toHaveBeenCalledWith(
    "video",
    expect.anything(),
  );
  expect(
    late.replaceTrack.mock.calls.filter(([track]) => track !== null),
  ).toHaveLength(0);
  await camera.resumeUpstream();
  expect(late.replaceTrack).toHaveBeenCalledWith(sc.mediaStreamTrack);
});
