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
