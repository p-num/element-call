/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { of } from "rxjs";
import { StrictMode } from "react";
import {
  RemoteAudioTrack,
  RemoteParticipant,
  RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
} from "livekit-client";
import { MediaDevicesContext } from "../MediaDevicesContext";
import { LivekitRoomAudioRenderer } from "./MatrixAudioRenderer";
import { mockMediaDevices } from "../utils/test";
import { IOSControlledAudioOutput } from "../state/IOSControlledAudioOutput";
import { ObservableScope } from "../state/ObservableScope";
import { constant } from "../state/Behavior";
import { setRemoteAudioVolume } from "./RemoteAudioVolume";
import { availableOutputDevices$ } from "../controls";

// Keep real LiveKit HTML attachment, Room and remote tracks. Only signalling
// and browser hardware are replaced, so startAudio can expose the original bypass.
vi.mock("../Platform", () => ({ platform: "ios" }));
vi.mock("@livekit/components-core", async (original) => ({
  ...(await original()),
  createMediaDeviceObserver: () => of([]),
}));

class Stream extends EventTarget {
  constructor(private tracks: MediaStreamTrack[] = []) {
    super();
  }
  getTracks(): MediaStreamTrack[] {
    return this.tracks;
  }
  getAudioTracks(): MediaStreamTrack[] {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks(): MediaStreamTrack[] {
    return [];
  }
  addTrack(track: MediaStreamTrack): void {
    this.tracks.push(track);
  }
  removeTrack(track: MediaStreamTrack): void {
    this.tracks = this.tracks.filter((t) => t !== track);
  }
}
class AudioNodeMock {
  connect = vi.fn((next: AudioNodeMock) => next);
  disconnect = vi.fn();
  gain = { value: 1 };
  pan = { value: 0 };
}
class Context {
  static instances: Context[] = [];
  state = "running";
  destination = new AudioNodeMock();
  sources: AudioNodeMock[] = [];
  gains: AudioNodeMock[] = [];
  panners: AudioNodeMock[] = [];
  constructor() {
    Context.instances.push(this);
  }
  createGain = (): AudioNodeMock => {
    if (this.state === "closed") throw new Error("AudioContext is closed");
    const node = new AudioNodeMock();
    this.gains.push(node);
    return node;
  };
  createStereoPanner = (): AudioNodeMock => {
    if (this.state === "closed") throw new Error("AudioContext is closed");
    const node = new AudioNodeMock();
    this.panners.push(node);
    return node;
  };
  createMediaStreamSource = vi.fn((_stream: Stream) => {
    if (this.state === "closed") throw new Error("AudioContext is closed");
    const node = new AudioNodeMock();
    this.sources.push(node);
    return node;
  });
  resume = vi.fn(async () => {
    this.state = "running";
    await Promise.resolve();
  });
  close = vi.fn(async () => {
    this.state = "closed";
    await Promise.resolve();
  });
}

beforeEach(() => {
  Context.instances = [];
  vi.stubGlobal("MediaStream", Stream);
  vi.stubGlobal("AudioContext", Context);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function remoteTrack(id: string): RemoteAudioTrack {
  const mediaTrack = Object.assign(new EventTarget(), {
    id,
    kind: "audio",
    enabled: true,
    getSettings: () => ({}),
  });
  return new RemoteAudioTrack(
    mediaTrack as MediaStreamTrack,
    id,
    {} as RTCRtpReceiver,
  );
}

function setup({ strict = false, initialVolume = 1, speaker = false } = {}) {
  const room = new Room({ webAudioMix: false });
  const participant = new RemoteParticipant(
    {} as ConstructorParameters<typeof RemoteParticipant>[0],
    "PA_1",
    "remote",
  );
  const track = remoteTrack("TR_1");
  const publication = new RemoteTrackPublication(
    Track.Kind.Audio,
    { sid: "TR_1", name: "microphone" } as ConstructorParameters<
      typeof RemoteTrackPublication
    >[1],
    true,
  );
  publication.source = Track.Source.Microphone;
  publication.setTrack(track);
  participant.audioTrackPublications.set("TR_1", publication);
  participant.trackPublications.set("TR_1", publication);
  room.remoteParticipants.set("remote", participant);
  const scope = new ObservableScope();
  const audioOutput = new IOSControlledAudioOutput(
    constant(false),
    scope,
    "audio",
  );
  availableOutputDevices$.next([
    { id: "speaker", name: "Speaker", isSpeaker: true, forEarpiece: true },
  ]);
  if (speaker) audioOutput.select("speaker");
  setRemoteAudioVolume(participant, initialVolume);
  const devices = mockMediaDevices({ audioOutput });
  const view = (muted = false) => (
    <MediaDevicesContext value={devices}>
      <LivekitRoomAudioRenderer
        url=""
        livekitRoom={room}
        validIdentities={["remote"]}
        muted={muted}
      />
    </MediaDevicesContext>
  );
  const screen = render(strict ? <StrictMode>{view()}</StrictMode> : view());
  return {
    room,
    participant,
    track,
    publication,
    audioOutput,
    view,
    ...screen,
    end: () => {
      screen.unmount();
      room.emit(RoomEvent.Disconnected);
      scope.end();
    },
  };
}

function expectHandset(context: Context): void {
  const index = context.sources.length - 1;
  expect(context.sources[index].connect).toHaveBeenCalledWith(
    context.gains[index],
  );
  expect(context.gains[index].gain.value).toBe(0.1);
  expect(context.gains[index].connect).toHaveBeenCalledWith(
    context.panners[index],
  );
  expect(context.panners[index].pan.value).toBe(1);
  expect(context.panners[index].connect).toHaveBeenCalledWith(
    context.destination,
  );
  expect(context.sources[index].disconnect).not.toHaveBeenCalled();
}

it("keeps handset gain and pan as the only playback path after LiveKit restarts audio", async () => {
  const call = setup();
  const context = Context.instances[0];
  expectHandset(context);
  await act(async () => {
    await call.room.startAudio();
  });
  expect(call.audioOutput.selected$.value?.virtualEarpiece).toBe(true);
  expect(call.container.querySelectorAll("audio")).toHaveLength(0);
  expect(call.track.attachedElements).toHaveLength(0);
  expectHandset(context);
  call.end();
  expect(context.close).toHaveBeenCalledOnce();
  expect(context.sources[0].disconnect).toHaveBeenCalledOnce();
  expect(context.gains[0].disconnect).toHaveBeenCalledOnce();
  expect(context.panners[0].disconnect).toHaveBeenCalledOnce();
});

it("disconnects muted handset audio and restores only the attenuated path on unmute", async () => {
  const call = setup();
  const context = Context.instances[0];
  call.rerender(call.view(true));
  expect(call.publication.isEnabled).toBe(false);
  expect(context.sources[0].disconnect).toHaveBeenCalledOnce();
  await act(async () => {
    await call.room.startAudio();
  });
  call.rerender(call.view(false));
  expect(call.publication.isEnabled).toBe(true);
  expect(call.track.attachedElements).toHaveLength(0);
  expectHandset(context);
  call.end();
});

it("switches between exclusive handset and normal HTML speaker playback", async () => {
  const call = setup();
  const first = Context.instances[0];
  act(() => call.audioOutput.select("speaker"));
  expect(first.close).toHaveBeenCalledOnce();
  expect(first.sources[0].disconnect).toHaveBeenCalledOnce();
  expect(call.track.attachedElements).toHaveLength(1);
  expect(call.container.querySelector("audio")?.muted).toBe(false);
  await act(async () => {
    await call.room.startAudio();
  });
  act(() => call.audioOutput.select("earpiece-id"));
  expect(call.track.attachedElements).toHaveLength(0);
  expect(call.container.querySelectorAll("audio")).toHaveLength(0);
  expectHandset(Context.instances.at(-1)!);
  call.end();
});

it("replaces the source on subscription events without a parent rerender", () => {
  const call = setup();
  const context = Context.instances[0];
  const replacement = remoteTrack("TR_replacement");
  act(() => {
    call.publication.setTrack(replacement);
    call.room.emit(
      RoomEvent.TrackSubscribed,
      replacement,
      call.publication,
      call.participant,
    );
  });
  expect(context.sources[0].disconnect).toHaveBeenCalledOnce();
  const stream = context.createMediaStreamSource.mock.calls.at(
    -1,
  )?.[0] as unknown as Stream;
  expect(stream.getAudioTracks()).toEqual([replacement.mediaStreamTrack]);
  expectHandset(context);
  call.end();
});

it("resumes the handset context on visibility restoration without attaching HTML playback", () => {
  const call = setup();
  const context = Context.instances[0];
  context.state = "suspended";
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(context.state).toBe("running");
  expect(call.track.attachedElements).toHaveLength(0);
  expectHandset(context);
  call.end();
});

it("keeps simultaneous remote tracks isolated and disconnects a removed track", () => {
  const call = setup();
  const context = Context.instances[0];
  const publication = new RemoteTrackPublication(
    Track.Kind.Audio,
    { sid: "TR_2", name: "screenshare" } as ConstructorParameters<
      typeof RemoteTrackPublication
    >[1],
    true,
  );
  publication.setTrack(remoteTrack("TR_2"));
  publication.source = Track.Source.ScreenShareAudio;
  act(() => {
    call.participant.audioTrackPublications.set("TR_2", publication);
    call.participant.trackPublications.set("TR_2", publication);
    call.room.emit(
      RoomEvent.TrackSubscribed,
      publication.track!,
      publication,
      call.participant,
    );
  });
  expect(context.sources).toHaveLength(2);
  expect(context.sources[0].connect).toHaveBeenCalledExactlyOnceWith(
    context.gains[0],
  );
  expect(context.sources[1].connect).toHaveBeenCalledExactlyOnceWith(
    context.gains[1],
  );
  expect(context.gains[0].connect).toHaveBeenCalledExactlyOnceWith(
    context.panners[0],
  );
  expect(context.gains[1].connect).toHaveBeenCalledExactlyOnceWith(
    context.panners[1],
  );
  act(() =>
    setRemoteAudioVolume(call.participant, 0.3, Track.Source.ScreenShareAudio),
  );
  expect(context.gains[0].gain.value).toBe(0.1);
  expect(context.gains[1].gain.value).toBeCloseTo(0.03);
  act(() => {
    call.participant.audioTrackPublications.delete("TR_1");
    call.participant.trackPublications.delete("TR_1");
    call.room.emit(
      RoomEvent.TrackUnpublished,
      call.publication,
      call.participant,
    );
  });
  expect(context.sources[0].disconnect).toHaveBeenCalledOnce();
  expect(context.sources[1].disconnect).not.toHaveBeenCalled();
  call.end();
});

it("preserves participant volume, mute and volume changes across route switches", async () => {
  const call = setup();
  const context = Context.instances[0];
  act(() => setRemoteAudioVolume(call.participant, 0.4));
  expect(context.gains[0].gain.value).toBeCloseTo(0.04);
  act(() => setRemoteAudioVolume(call.participant, 0));
  expect(context.gains[0].gain.value).toBe(0);
  act(() => call.audioOutput.select("speaker"));
  expect(call.container.querySelector("audio")).toBeNull();
  expect(call.publication.isEnabled).toBe(false);
  await act(async () => call.room.startAudio());
  expect(call.track.attachedElements).toHaveLength(0);
  act(() => setRemoteAudioVolume(call.participant, 0.6));
  expect(call.publication.isEnabled).toBe(true);
  expect(call.container.querySelector("audio")?.volume).toBe(0.6);
  act(() => call.audioOutput.select("earpiece-id"));
  expect(Context.instances.at(-1)!.gains[0].gain.value).toBeCloseTo(0.06);
  call.end();
});

it("releases discarded contexts and nodes under React StrictMode", () => {
  const call = setup({ strict: true });
  expect(Context.instances[0].close).toHaveBeenCalledOnce();
  expectHandset(Context.instances.at(-1)!);
  call.end();
  for (const context of Context.instances) {
    expect(context.close).toHaveBeenCalledOnce();
    for (const source of context.sources)
      expect(source.disconnect).toHaveBeenCalledOnce();
  }
});

it("disconnects handset playback on an unsubscribe event without a parent rerender", () => {
  const call = setup();
  const context = Context.instances[0];
  act(() => {
    call.publication.setTrack(undefined);
    call.room.emit(
      RoomEvent.TrackUnsubscribed,
      call.track,
      call.publication,
      call.participant,
    );
  });
  expect(context.sources[0].disconnect).toHaveBeenCalledOnce();
  expect(context.gains[0].disconnect).toHaveBeenCalledOnce();
  expect(context.panners[0].disconnect).toHaveBeenCalledOnce();
  call.end();
});

it("applies requested volume before the first speaker attachment", () => {
  const call = setup({ initialVolume: 0.4, speaker: true });
  expect(Context.instances).toHaveLength(0);
  expect(call.container.querySelector("audio")?.volume).toBe(0.4);
  call.end();
});

it("keeps initially muted speaker playback detached until unmuted", async () => {
  const call = setup({ initialVolume: 0, speaker: true });
  expect(call.track.attachedElements).toHaveLength(0);
  expect(call.publication.isEnabled).toBe(false);
  await act(async () => call.room.startAudio());
  expect(call.track.attachedElements).toHaveLength(0);
  act(() => setRemoteAudioVolume(call.participant, 0.5));
  expect(call.publication.isEnabled).toBe(true);
  expect(call.container.querySelector("audio")?.volume).toBe(0.5);
  call.end();
});

it("applies requested volume to replacement speaker tracks", () => {
  const call = setup({ initialVolume: 0.4, speaker: true });
  const replacement = remoteTrack("TR_replacement");
  act(() => {
    call.publication.setTrack(replacement);
    call.room.emit(
      RoomEvent.TrackSubscribed,
      replacement,
      call.publication,
      call.participant,
    );
  });
  expect(call.track.attachedElements).toHaveLength(0);
  expect(replacement.attachedElements).toHaveLength(1);
  expect(call.container.querySelector("audio")?.volume).toBe(0.4);
  call.end();
});

it("keeps global and participant mute independent through route changes", async () => {
  const call = setup();
  const context = Context.instances[0];
  call.rerender(call.view(true));
  act(() => {
    setRemoteAudioVolume(call.participant, 0);
    call.audioOutput.select("speaker");
    setRemoteAudioVolume(call.participant, 0.5);
  });
  expect(call.publication.isEnabled).toBe(false);
  expect(call.track.attachedElements).toHaveLength(0);
  expect(context.sources[0].disconnect).toHaveBeenCalledOnce();
  await act(async () => call.room.startAudio());
  expect(call.track.attachedElements).toHaveLength(0);
  expect(call.publication.isEnabled).toBe(false);
  call.rerender(call.view(false));
  expect(call.publication.isEnabled).toBe(true);
  expect(call.container.querySelector("audio")?.volume).toBe(0.5);
  act(() => setRemoteAudioVolume(call.participant, 0));
  call.rerender(call.view(true));
  call.rerender(call.view(false));
  expect(call.publication.isEnabled).toBe(false);
  expect(call.track.attachedElements).toHaveLength(0);
  call.end();
});

it("releases volume subscriptions when handset playback ends", () => {
  const call = setup();
  const context = Context.instances[0];
  call.end();
  act(() => setRemoteAudioVolume(call.participant, 0.5));
  expect(context.gains[0].gain.value).toBe(0.1);
  expect(context.sources[0].disconnect).toHaveBeenCalledOnce();
});
