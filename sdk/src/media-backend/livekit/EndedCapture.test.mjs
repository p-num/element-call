/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { EventEmitter } from "events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  LocalAudioTrack,
  LocalParticipant,
  LocalTrackPublication,
  LocalVideoTrack,
  Room,
  Track,
  TrackEvent,
} from "livekit-client";
import { Capture, Stream, sender } from "./capture-fixture.mjs";

let acquire, enumerate, permission, query, visibility;
const tracks = [];
beforeEach(() => {
  acquire = vi.fn();
  enumerate = vi
    .fn()
    .mockResolvedValue([{ kind: "audioinput", deviceId: "fallback" }]);
  permission = new EventTarget();
  permission.state = "granted";
  permission.addEventListener("change", () => permission.onchange?.());
  query = vi.fn().mockResolvedValue(permission);
  vi.stubGlobal("MediaStream", Stream);
  vi.stubGlobal("MediaStreamTrack", Capture);
  vi.stubGlobal("navigator", {
    userAgent: "Mobile",
    mediaDevices: { getUserMedia: acquire, enumerateDevices: enumerate },
    permissions: { query },
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility,
  );
});
afterEach(() => {
  tracks.splice(0).forEach((t) => {
    t.detach();
    t.stop();
  });
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  ["audio", "absent"],
  ["video", "absent"],
  ["video", "attached"],
  ["video", "detached"],
])(
  "recovers an ended %s capture with its preview %s on a real foreground event",
  async (kind, preview) => {
    const { track, end, publication, primary } = await published(kind);
    const muted = vi.fn();
    track.on(TrackEvent.Muted, muted);
    if (preview !== "absent") track.attach(document.createElement("video"));
    acquire.mockRejectedValue(new DOMException("busy", "NotAllowedError"));
    await end();
    expect(muted).not.toHaveBeenCalled();
    if (preview === "detached") track.detach();
    const replacement = new Capture(kind);
    acquire.mockClear().mockResolvedValue(new Stream([replacement]));
    foreground();
    foreground();
    await vi.waitFor(() => expect(track.mediaStreamTrack).toBe(replacement));
    expect(publication.track).toBe(track);
    expect(acquire).toHaveBeenCalledOnce();
    expect(
      primary.replaceTrack.mock.calls.filter(([t]) => t === replacement),
    ).toHaveLength(1);
  },
);

it.each(["mute", "stop", "unpublish", "replace"])(
  "cancels a pending foreground opportunity on %s",
  async (action) => {
    const fixture = await published("audio");
    acquire.mockRejectedValue(new DOMException("busy", "NotAllowedError"));
    await fixture.end();
    await cancel(fixture, action);
    acquire.mockClear();
    foreground();
    await tick();
    expect(acquire).not.toHaveBeenCalled();
  },
);

it.each([
  ["audio", "mute"],
  ["video", "mute"],
  ["audio", "stop"],
  ["video", "unpublish"],
  ["audio", "replace"],
])("disposes the in-flight %s candidate after %s", async (kind, action) => {
  const fixture = await published(kind);
  fixture.track.stopOnMute = true;
  const requested = Promise.withResolvers();
  const granted = Promise.withResolvers();
  acquire.mockImplementationOnce(() => {
    requested.resolve();
    return granted.promise;
  });
  const ended = fixture.end();
  await requested.promise;
  const cancellation = cancel(fixture, action);
  if (action !== "replace") await cancellation;
  const unused = new Capture(kind);
  granted.resolve(new Stream([unused]));
  await Promise.all([ended, cancellation]);
  expect(unused.readyState).toBe("ended");
  expect(fixture.primary.replaceTrack).not.toHaveBeenCalledWith(unused);
  expect(fixture.track.mediaStreamTrack).not.toBe(unused);
});

it.each(["permission", "processor", "sender"])(
  "respects unpublish while awaiting the %s",
  async (boundary) => {
    const fixture = await published("audio");
    const entered = Promise.withResolvers();
    const finish = Promise.withResolvers();
    const candidate = new Capture("audio");
    acquire.mockResolvedValue(new Stream([candidate]));
    const pause = () => {
      entered.resolve();
      return finish.promise;
    };
    if (boundary === "permission") query.mockImplementationOnce(pause);
    if (boundary === "processor")
      fixture.track.processor = { restart: pause, destroy: async () => {} };
    if (boundary === "sender")
      fixture.primary.replaceTrack.mockImplementationOnce(pause);
    const ended = fixture.end();
    await entered.promise;
    await fixture.participant.unpublishTrack(fixture.track, false);
    finish.resolve(permission);
    await ended;
    if (boundary === "permission") expect(acquire).not.toHaveBeenCalled();
    else expect(candidate.readyState).toBe("ended");
    expect(fixture.track.mediaStreamTrack).not.toBe(candidate);
  },
);

it("revokes the permission retry if the publication is removed before access returns", async () => {
  const fixture = await published("audio");
  permission.state = "denied";
  acquire.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
  await fixture.end();
  expect(acquire).not.toHaveBeenCalled();
  await fixture.participant.unpublishTrack(fixture.track, false);
  permission.state = "granted";
  permission.dispatchEvent(new Event("change"));
  foreground();
  await tick();
  expect(acquire).not.toHaveBeenCalled();
});

it("recovers when permission returns and retains the enumerated microphone fallback", async () => {
  const fixture = await published("audio");
  permission.state = "denied";
  const replacement = new Capture("audio", { deviceId: "fallback" });
  acquire
    .mockRejectedValueOnce(new DOMException("busy", "NotReadableError"))
    .mockResolvedValue(new Stream([replacement]));
  await fixture.end();
  expect(acquire).not.toHaveBeenCalled();
  permission.state = "granted";
  permission.dispatchEvent(new Event("change"));
  await vi.waitFor(() =>
    expect(fixture.track.mediaStreamTrack).toBe(replacement),
  );
  expect(enumerate).toHaveBeenCalledOnce();
  expect(acquire.mock.lastCall[0].audio.deviceId).toBe("fallback");
});

it("still supports an explicitly requested restart after stop", async () => {
  const { track } = await published("audio");
  track.stop();
  const next = new Capture("audio");
  acquire.mockResolvedValue(new Stream([next]));
  await track.restartTrack();
  expect(track.mediaStreamTrack).toBe(next);
  expect(track.isStopped).toBe(false);
});

it.each([
  [Track.Source.ScreenShare, "video"],
  [Track.Source.ScreenShareAudio, "audio"],
  [Track.Source.Microphone, "audio"],
])("retains caller ownership for ended %s", async (source, kind) => {
  const fixture = await published(kind, true);
  fixture.track.source = source;
  await fixture.end();
  if (source === Track.Source.Microphone)
    expect(fixture.track.isMuted).toBe(true);
  else expect(fixture.participant.trackPublications.size).toBe(0);
  expect(acquire).not.toHaveBeenCalled();
});

it("retries a candidate microphone that ends while the sender bind is pending", async () => {
  const { track, primary, end, participant } =
    await publishThroughRoom("audio");
  const first = new Capture("audio");
  const next = new Capture("audio");
  acquire
    .mockResolvedValueOnce(new Stream([first]))
    .mockResolvedValueOnce(new Stream([next]));
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  primary.replaceTrack.mockImplementationOnce(async (candidate) => {
    started.resolve();
    await finish.promise;
    primary.track = candidate;
  });
  const original = track.mediaStreamTrack;
  end();
  await started.promise;
  first.stop();
  first.dispatchEvent(new Event("ended"));
  finish.resolve();
  await tick();
  expect(track.mediaStreamTrack).toBe(original);
  foreground();
  await vi.waitFor(() => expect(primary.track).toBe(next));
  expect(
    participant.getTrackPublication(Track.Source.Microphone).track
      .mediaStreamTrack,
  ).toBe(next);
  expect(acquire).toHaveBeenCalledTimes(2);
});

it("discards a processed camera output produced after unpublish cancels recovery", async () => {
  const { track, end, participant } = await publishThroughRoom("video");
  const originalOutput = new Capture("video");
  const rejected = new Capture("video");
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const processor = {
    name: "delayed output",
    async init() {
      this.processedTrack = originalOutput;
      return Promise.resolve();
    },
    async restart() {
      this.processedTrack.stop();
      started.resolve();
      await finish.promise;
      this.processedTrack = rejected;
    },
    async destroy() {
      this.processedTrack?.stop();
      return Promise.resolve();
    },
  };
  await track.setProcessor(processor);
  const candidate = new Capture("video");
  acquire.mockResolvedValueOnce(new Stream([candidate]));
  end();
  await started.promise;
  await participant.unpublishTrack(track, false);
  finish.resolve();
  await tick();
  expect(candidate.readyState).toBe("ended");
  expect(rejected.readyState).toBe("ended");
  expect(track.mediaStreamTrack).not.toBe(rejected);
});

it.each([
  ["audio", "iPhone"],
  ["video", "iPhone"],
  ["audio", "iPad"],
])(
  "recovers busy %s on %s after hardware returns without another event",
  async (kind, platform) => {
    const fixture = await busyForeground(kind, platform);
    const next = new Capture(kind, { width: 640, height: 360 });
    acquire.mockResolvedValue(new Stream([next]));
    await vi.advanceTimersByTimeAsync(999);
    expect(acquire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(acquire).toHaveBeenCalledOnce();
    expect(fixture.primary.track).toBe(next);
    expect(
      fixture.participant.getTrackPublication(fixture.track.source).track,
    ).toBe(fixture.track);
    expect(fixture.track.mediaStreamTrack).toBe(next);
  },
);

it("spends the single delayed opportunity even if hardware stays busy", async () => {
  await busyForeground("video");
  await vi.advanceTimersByTimeAsync(1000);
  expect(acquire).toHaveBeenCalledOnce();
  foreground();
  await vi.advanceTimersByTimeAsync(0);
  expect(acquire).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(10000);
  expect(acquire).toHaveBeenCalledTimes(2);
});

it.each([
  "hidden",
  "prompt",
  "denied",
  "mute",
  "stop",
  "unpublish",
  "replace",
  "sender",
  "closed",
])("skips the delayed acquisition after %s", async (reason) => {
  const fixture = await busyForeground("audio");
  if (reason === "hidden") visibility = "hidden";
  else if (reason === "prompt" || reason === "denied")
    permission.state = reason;
  else if (reason === "sender") fixture.track.sender = sender();
  else if (reason === "closed") fixture.primary.transport = { state: "closed" };
  else await cancel(fixture, reason);
  await vi.advanceTimersByTimeAsync(3000);
  expect(acquire).not.toHaveBeenCalled();
});

it.each(["hidden", "denied", "mute", "unpublish"])(
  "disposes the timed candidate after %s",
  async (reason) => {
    const fixture = await busyForeground("audio");
    const pending = Promise.withResolvers();
    acquire.mockImplementationOnce(() => pending.promise);
    await vi.advanceTimersByTimeAsync(1000);
    expect(acquire).toHaveBeenCalledOnce();
    if (reason === "hidden") visibility = "hidden";
    else if (reason === "denied") permission.state = reason;
    else await cancel(fixture, reason);
    const candidate = new Capture("audio");
    pending.resolve(new Stream([candidate]));
    await vi.advanceTimersByTimeAsync(0);
    expect(candidate.readyState).toBe("ended");
    expect(fixture.primary.replaceTrack).not.toHaveBeenCalledWith(candidate);
    if (reason === "hidden" || reason === "denied") {
      const next = new Capture("audio");
      acquire.mockResolvedValue(new Stream([next]));
      permission.state = "granted";
      foreground();
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.primary.track).toBe(next);
    }
  },
);

it("respects the start deadline after waiting for the fallback microphone list", async () => {
  await busyForeground("audio");
  const devices = Promise.withResolvers();
  enumerate.mockImplementationOnce(() => devices.promise);
  await vi.advanceTimersByTimeAsync(3000);
  expect(acquire).toHaveBeenCalledOnce();
  devices.resolve([{ kind: "audioinput", deviceId: "late" }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(acquire).toHaveBeenCalledOnce();
});

it("accepts a timely request that settles after the deadline and preserves caller pause", async () => {
  const fixture = await busyForeground("audio");
  await fixture.track.pauseUpstream();
  const pending = Promise.withResolvers();
  acquire.mockReturnValueOnce(pending.promise);
  await vi.advanceTimersByTimeAsync(4000);
  const next = new Capture("audio");
  pending.resolve(new Stream([next]));
  await vi.advanceTimersByTimeAsync(0);
  expect(fixture.track.mediaStreamTrack).toBe(next);
  expect(fixture.primary.track).toBeNull();
  await fixture.track.resumeUpstream();
  expect(fixture.primary.track).toBe(next);
});

it.each(["NotAllowedError", "AbortError", "NotFoundError"])(
  "does not retry a final %s",
  async (name) => {
    await busyForeground("audio", "iPhone", name);
    await vi.advanceTimersByTimeAsync(3000);
    expect(acquire).not.toHaveBeenCalled();
  },
);

async function busyForeground(
  kind,
  platform = "iPhone",
  errorName = "NotReadableError",
) {
  const fixture = await publishThroughRoom(kind);
  navigator.userAgent =
    platform === "iPad"
      ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15"
      : "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/23A";
  navigator.maxTouchPoints = 5;
  vi.useFakeTimers();
  visibility = "hidden";
  acquire.mockRejectedValue(new DOMException("busy", errorName));
  fixture.end();
  await vi.advanceTimersByTimeAsync(0);
  acquire.mockClear();
  foreground();
  await vi.advanceTimersByTimeAsync(0);
  expect(acquire).toHaveBeenCalled();
  acquire.mockClear();
  return fixture;
}

async function publishThroughRoom(kind) {
  const room = new Room();
  const participant = room.localParticipant;
  const engine = room.engine;
  const source =
    kind === "audio" ? Track.Source.Microphone : Track.Source.Camera;
  const capture = new Capture(kind, { width: 640, height: 360 });
  const track =
    kind === "audio"
      ? new LocalAudioTrack(capture, {}, false)
      : new LocalVideoTrack(capture, {}, false);
  tracks.push(track);
  const primary = sender();
  primary.track = capture;
  primary.replaceTrack.mockImplementation(async (next) => {
    primary.track = next;
    return Promise.resolve();
  });
  Object.defineProperty(engine.client, "currentState", { value: 1 });
  Object.defineProperty(engine, "isClosed", { value: false });
  engine.pcManager = {
    currentState: 0,
    publisher: {
      getTransceivers: () => [{ sender: primary, direction: "sendonly" }],
    },
  };
  engine.addTrack = async (request) =>
    Promise.resolve({
      ...request,
      sid: "public-track",
      codecs: [],
      audioFeatures: [],
    });
  engine.createSender = vi.fn().mockResolvedValue(primary);
  engine.removeTrack = () => {
    primary.track = null;
    return true;
  };
  engine.negotiate = vi.fn().mockResolvedValue(undefined);
  participant.setPermissions({ canPublish: true, canPublishSources: [] });
  await participant.publishTrack(track, { source, simulcast: false });
  return {
    track,
    primary,
    participant,
    end() {
      capture.stop();
      capture.dispatchEvent(new Event("ended"));
    },
  };
}

async function published(kind, provided = false) {
  const capture = new Capture(kind);
  const track =
    kind === "audio"
      ? new LocalAudioTrack(capture, {}, provided)
      : new LocalVideoTrack(capture, {}, provided);
  tracks.push(track);
  await tick();
  track.source =
    kind === "audio" ? Track.Source.Microphone : Track.Source.Camera;
  track.sid = "local-track";
  const primary = sender();
  track.sender = primary;
  const participant = new LocalParticipant(
    "local",
    "test",
    new EventEmitter(),
    {},
  );
  const publication = new LocalTrackPublication(
    track.kind,
    { sid: track.sid, name: kind },
    track,
  );
  participant.trackPublications.set(track.sid, publication);
  let pending;
  track.on(TrackEvent.Ended, () => {
    pending = participant.handleTrackEnded(track);
  });
  return {
    track,
    primary,
    publication,
    participant,
    end() {
      capture.readyState = "ended";
      capture.dispatchEvent(new Event("ended"));
      return pending;
    },
  };
}

function cancel({ track, participant }, action) {
  switch (action) {
    case "mute":
      return track.mute();
    case "stop":
      return track.stop();
    case "unpublish":
      return participant.unpublishTrack(track, false);
    case "replace":
      return track.replaceTrack(new Capture(track.kind), false);
  }
}

function foreground() {
  visibility = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
}

async function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
