/* Copyright 2026 p-num. SPDX-License-Identifier: AGPL-3.0-only */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { BehaviorSubject } from "rxjs";
import {
  RemoteAudioTrack,
  RemoteParticipant,
  RemoteTrackPublication,
  Room,
  Track,
} from "livekit-client";
import { type AudioMediaTrack } from "@element-hq/matrixrtc-sdk";
import { ObservableScope } from "../../sdk/src/reactive/ObservableScope";
import { createLivekitMediaTrack } from "../../sdk/src/media-backend/livekit/LivekitMediaTrack";
import { MemberAudioRenderer } from "./MemberAudioRenderer";
import { mockRTCMember, mockRtcMembership } from "../utils/test";

const route = vi.hoisted(() => ({ earpiece: true }));
vi.mock("../MediaDevicesContext", () => ({
  useEarpieceAudioConfig: () => ({
    pan: route.earpiece ? 1 : 0,
    volume: route.earpiece ? 0.1 : 1,
  }),
}));
beforeEach(() => {
  Context.instances = [];
  route.earpiece = true;
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

test("LiveKit audio restart cannot create HTML playback beside the handset graph", async () => {
  const call = setup();
  const context = Context.instances[0];
  expect(call.peers[0].track.attachedElements).toHaveLength(0);
  expect(graph(context).handsetGain.gain.value).toBe(0.1);
  expect(graph(context).panner.pan.value).toBe(1);
  await act(async () => {
    await call.room.startAudio();
  });
  expect(call.peers[0].track.attachedElements).toHaveLength(0);
  expect(graph(context).source.disconnect).not.toHaveBeenCalled();
  call.end();
  expect(graph(context).source.disconnect).toHaveBeenCalledOnce();
});

test("speaker and handset route round trips retain exactly one playback path", async () => {
  const call = setup();
  const context = Context.instances[0];
  route.earpiece = false;
  call.rerender(call.view());
  expect(graph(context).source.disconnect).toHaveBeenCalledOnce();
  expect(call.peers[0].track.attachedElements).toHaveLength(1);
  expect(call.peers[0].track.attachedElements[0].muted).toBe(false);
  await act(async () => {
    await call.room.startAudio();
  });
  route.earpiece = true;
  call.rerender(call.view());
  expect(call.peers[0].track.attachedElements).toHaveLength(0);
  expect(graph(context).handsetGain.gain.value).toBe(0.1);
  call.end();
});

test("a muted handset stays silent through track replacement and audio restart", async () => {
  const call = setup();
  const context = Context.instances[0];
  call.rerender(call.view(true));
  expect(graph(context).source.disconnect).toHaveBeenCalledOnce();
  const replacement = remoteTrack("replacement");
  act(() => call.peers[0].publication.setTrack(replacement));
  await act(async () => {
    await call.room.startAudio();
  });
  expect(replacement.attachedElements).toHaveLength(0);
  expect(context.sources).toHaveLength(1);
  call.rerender(call.view(false));
  const stream = context.createMediaStreamSource.mock.calls.at(
    -1,
  )?.[0] as Stream;
  expect(stream.getAudioTracks()).toEqual([replacement.mediaStreamTrack]);
  expect(replacement.attachedElements).toHaveLength(0);
  call.end();
});

test("zero participant volume disconnects the handset across replacements", () => {
  const call = setup();
  const context = Context.instances[0];
  act(() => call.peers[0].media.setVolume(0));
  expect(graph(context).source.disconnect).toHaveBeenCalledOnce();
  act(() => call.peers[0].publication.setTrack(remoteTrack("replacement")));
  expect(context.sources).toHaveLength(1);
  act(() => call.peers[0].media.setVolume(0.4));
  expect(graph(context).requestedGain.gain.value).toBe(0.4);
  expect(graph(context).handsetGain.gain.value).toBe(0.1);
  call.end();
});

test("two remote tracks have independent gains and panners", () => {
  const call = setup(2);
  const context = Context.instances[0];
  const first = graph(context, 0);
  const second = graph(context, 1);
  expect(first.handsetGain).not.toBe(second.handsetGain);
  expect(first.panner).not.toBe(second.panner);
  act(() => call.peers[0].media.setVolume(0.3));
  expect(first.requestedGain.gain.value).toBe(0.3);
  expect(second.requestedGain.gain.value).toBe(1);
  act(() => call.peers[0].media.setVolume(0));
  expect(first.source.disconnect).toHaveBeenCalledOnce();
  expect(second.source.disconnect).not.toHaveBeenCalled();
  expect(call.peers[1].track.attachedElements).toHaveLength(0);
  call.end();
});

test("foreground restoration resumes the handset context without HTML playback", () => {
  const call = setup();
  const context = Context.instances[0];
  const resumes = context.resume.mock.calls.length;
  context.state = "suspended";
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(context.state).toBe("running");
  expect(context.resume).toHaveBeenCalledTimes(resumes + 1);
  expect(call.peers[0].track.attachedElements).toHaveLength(0);
  call.end();
  context.state = "suspended";
  document.dispatchEvent(new Event("visibilitychange"));
  expect(context.resume).toHaveBeenCalledTimes(resumes + 1);
});

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
  gain = { value: 1, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn() };
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
  createOscillator = () => ({ connect: vi.fn(), start: vi.fn() });
  createMediaStreamDestination = () => {
    const silent = {
      kind: "audio",
      enabled: true,
      stop: vi.fn(),
      clone: () => ({ kind: "audio", enabled: true, stop: vi.fn() }),
    };
    return { stream: new Stream([silent as unknown as MediaStreamTrack]) };
  };
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
function setup(count = 1) {
  const room = new Room({ webAudioMix: false });
  const scope = new ObservableScope();
  const peers = Array.from({ length: count }, (_, index) => {
    const id = `remote-${index}`;
    const participant = new RemoteParticipant(
      {} as ConstructorParameters<typeof RemoteParticipant>[0],
      `PA_${index}`,
      id,
    );
    const track = remoteTrack(`TR_${index}`);
    const publication = new RemoteTrackPublication(
      Track.Kind.Audio,
      { sid: `TR_${index}`, name: "microphone" } as ConstructorParameters<
        typeof RemoteTrackPublication
      >[1],
      true,
    );
    publication.source = Track.Source.Microphone;
    publication.setTrack(track);
    participant.audioTrackPublications.set(publication.trackSid, publication);
    participant.trackPublications.set(publication.trackSid, publication);
    room.remoteParticipants.set(id, participant);
    const media = createLivekitMediaTrack(
      scope,
      participant,
      publication,
      room,
    ) as AudioMediaTrack;
    const member = mockRTCMember(false, {
      membership: mockRtcMembership(`@${id}:example.org`, "DEVICE"),
      tracks$: new BehaviorSubject([media]),
    });
    return { track, publication, participant, media, member };
  });
  const view = (muted = false) => (
    <MemberAudioRenderer
      members={peers.map(({ member }) => member)}
      muted={muted}
    />
  );
  const screen = render(view());
  return {
    ...screen,
    peers,
    room,
    view,
    end: () => {
      screen.unmount();
      scope.end();
    },
  };
}
function graph(context: Context, index = context.sources.length - 1) {
  const source = context.sources[index];
  const requestedGain = source.connect.mock.calls[0][0];
  const handsetGain = requestedGain.connect.mock.calls[0][0];
  const panner = handsetGain.connect.mock.calls[0][0];
  return { source, requestedGain, handsetGain, panner };
}
