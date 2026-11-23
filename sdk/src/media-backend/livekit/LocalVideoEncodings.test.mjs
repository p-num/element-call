/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalVideoTrack, Track, VideoQuality } from "livekit-client";
import { Capture, Stream, sender } from "./capture-fixture.mjs";

const large = { width: 1280, height: 720 };
const small = { width: 640, height: 360 };
const tracks = [];
beforeEach(() => vi.stubGlobal("MediaStream", Stream));
afterEach(async () => {
  tracks.splice(0).forEach((t) => t.stop());
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("can still disable a negotiated layer after a smaller camera has fewer proposed layers", async () => {
  const { track, primary, swap } = await publishedCamera();
  await swap(small);
  await track.setPublishingLayers(false, [
    { quality: VideoQuality.HIGH, enabled: false },
  ]);
  expect(primary.encodings.at(-1).active).toBe(false);
  primary.encodings = layers(2);
  await swap(small);
  expect(primary.encodings[0].maxBitrate).toBeGreaterThan(1);
});

it.each(["rejected", "mismatched"])(
  "retries the old dimensions after a %s backup update",
  async (failure) => {
    const { track, primary, swap } = await publishedCamera();
    const backup = sender(layers(3));
    const sc = track.addSimulcastTrack(
      "h264",
      backup.getParameters().encodings,
    );
    await track.setSimulcastTrackSender("h264", backup);
    await swap(large);
    const old = primary.encodings.at(-1).maxBitrate;
    if (failure === "rejected")
      backup.setParameters.mockRejectedValueOnce(new Error("encoder busy"));
    else backup.encodings = layers(2);
    const larger = { width: 1920, height: 1080 };
    await swap(larger);
    expect(primary.encodings.at(-1).maxBitrate).not.toBe(old);
    expect(sc.encodings.at(-1).maxBitrate).toBe(old);
    backup.encodings = layers(3);
    await swap(large);
    expect(primary.encodings.at(-1).maxBitrate).toBe(old);
    expect(backup.encodings.at(-1).maxBitrate).toBe(old);
  },
);

it("refreshes the backup after a rejected primary and retries the same dimensions", async () => {
  const { track, primary, swap } = await publishedCamera();
  const backup = sender(layers(3));
  track.addSimulcastTrack("h264", backup.getParameters().encodings);
  await track.setSimulcastTrackSender("h264", backup);
  primary.setParameters.mockRejectedValueOnce(new Error("busy"));
  await swap(large);
  expect(backup.encodings[0].maxBitrate).toBeGreaterThan(1);
  await swap(large);
  expect(primary.encodings[0].maxBitrate).toBeGreaterThan(1);
});

it("only commits the baseline to the sender that acknowledged it", async () => {
  const { track, primary, swap } = await publishedCamera();
  const started = Promise.withResolvers();
  const written = Promise.withResolvers();
  primary.setParameters.mockImplementationOnce(() => {
    started.resolve();
    return written.promise;
  });
  const swapped = swap(large);
  await started.promise;
  expect(track.encodings).toEqual(layers(3));
  track.sender = sender(layers(3));
  written.resolve();
  await swapped;
  expect(track.encodings).toEqual(layers(3));
  await swap(large);
  expect(track.sender.encodings[0].maxBitrate).toBeGreaterThan(1);
});

it("retains the disabled layer's negotiated sentinel and its nominal restoration bitrate", async () => {
  const { track, primary, swap } = await publishedCamera();
  primary.encodings[0] = {
    rid: "q",
    active: false,
    maxBitrate: 1,
    scaleResolutionDownBy: 4,
  };
  await swap(large);
  expect(primary.encodings[0].maxBitrate).toBe(1);
  expect(track.encodings[0].maxBitrate).toBeGreaterThan(1);
});

it.each(["primary", "backup"])(
  "restores an enabled %s layer from the latest acknowledged refresh",
  async (target) => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 Gecko/20100101 Firefox/147.0",
    });
    const { track, primary, swap } = await publishedCamera();
    track.codec = "vp8";
    const backup = sender(layers(3));
    track.addSimulcastTrack("h264", backup.getParameters().encodings);
    await track.setSimulcastTrackSender("h264", backup);
    const selected = target === "primary" ? primary : backup;
    selected.encodings.at(-1).active = false;
    await swap(large);
    const accepted = Promise.withResolvers();
    const writing = Promise.withResolvers();
    const write = selected.setParameters.getMockImplementation().bind(selected);
    selected.setParameters.mockImplementationOnce(async (params) => {
      writing.resolve();
      await accepted.promise;
      await write(params);
    });
    const swapped = swap({ width: 1920, height: 1080 });
    await writing.promise;
    const qualities = [{ quality: VideoQuality.HIGH, enabled: true }];
    const enabled =
      target === "primary"
        ? track.setPublishingLayers(false, qualities)
        : track.setPublishingCodecs([{ codec: "h264", qualities }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    accepted.resolve();
    await Promise.all([swapped, enabled]);
    expect(selected.encodings.at(-1)).toMatchObject({
      active: true,
      maxBitrate: 3_000_000,
    });
  },
);

it("uses the same dimensions for both senders while other camera replacements queue", async () => {
  const { track, primary, swap } = await publishedCamera();
  const backup = sender(layers(3));
  track.addSimulcastTrack("h264", backup.getParameters().encodings);
  await track.setSimulcastTrackSender("h264", backup);
  const primaryWrite = deferWrite(primary);
  const backupWrite = deferWrite(backup);
  const hd = { width: 1920, height: 1080 };
  const first = swap(hd);
  await primaryWrite.started;
  const second = swap(large);
  await vi.waitFor(() =>
    expect(track.mediaStreamTrack.getSettings()).toBe(large),
  );
  primaryWrite.release();
  await backupWrite.started;
  const third = swap(hd);
  await vi.waitFor(() => expect(track.mediaStreamTrack.getSettings()).toBe(hd));
  backupWrite.release();
  await Promise.all([first, second, third]);
  expect(primary.encodings.at(-1).maxBitrate).toBe(3_000_000);
  expect(backup.encodings.at(-1).maxBitrate).toBe(3_000_000);
});

it("uses the processed dimensions for a two-layer backup on a larger raw camera", async () => {
  const { track, primary, swap } = await publishedCamera();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  const processor = {
    name: "resize",
    async init() {
      this.processedTrack = new Capture("video", small);
      return Promise.resolve();
    },
    async restart() {
      await this.init();
    },
    async destroy() {
      this.processedTrack.stop();
      return Promise.resolve();
    },
  };
  await track.setProcessor(processor);
  const backup = sender(layers(2));
  track.addSimulcastTrack("h264", backup.getParameters().encodings);
  await track.setSimulcastTrackSender("h264", backup);
  await swap({ width: 1920, height: 1080 });
  expect(primary.encodings.at(-1).maxBitrate).toBe(3_000_000);
  expect(backup.encodings.at(-1).maxBitrate).toBe(450_000);
});

function deferWrite(rtcSender) {
  const started = Promise.withResolvers();
  const accepted = Promise.withResolvers();
  const write = rtcSender.setParameters.getMockImplementation().bind(rtcSender);
  rtcSender.setParameters.mockImplementationOnce(async (params) => {
    started.resolve();
    await accepted.promise;
    await write(params);
  });
  return { started: started.promise, release: accepted.resolve };
}

async function publishedCamera() {
  const track = new LocalVideoTrack(new Capture("video", large), {}, false);
  tracks.push(track);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const primary = sender(layers(3));
  track.source = Track.Source.Camera;
  track.sender = primary;
  await new Promise((resolve) => setTimeout(resolve, 0));
  track.publishOptions = {
    simulcast: true,
    videoCodec: "vp8",
    backupCodec: { codec: "h264" },
  };
  track.startMonitor();
  primary.setParameters.mockClear();
  return {
    track,
    primary,
    swap: async (dims) => track.replaceTrack(new Capture("video", dims), false),
  };
}

function layers(count) {
  return ["q", "h", "f"]
    .slice(-count)
    .map((rid) => ({ rid, active: true, maxBitrate: 1 }));
}
