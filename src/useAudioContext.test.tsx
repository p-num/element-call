/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { expect, vi, afterEach, beforeEach, test } from "vitest";
import { Component, type ReactNode, type FC } from "react";
import { render, waitFor } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { BrowserRouter } from "react-router-dom";

import { MediaDevicesContext } from "./MediaDevicesContext";
import { useAudioContext } from "./useAudioContext";
import { soundEffectVolume as soundEffectVolumeSetting } from "./settings/settings";
import { mockMediaDevices } from "./utils/test";
import { constant } from "./state/Behavior";

const staticSounds = Promise.resolve({
  aSound: new ArrayBuffer(0),
});

const TestComponent: FC = () => {
  const audioCtx = useAudioContext({
    sounds: staticSounds,
    latencyHint: "balanced",
  });
  if (!audioCtx) {
    return null;
  }
  return (
    <>
      <button onClick={() => void audioCtx.playSound("aSound")}>
        Valid sound
      </button>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any*/}
      <button onClick={() => void audioCtx.playSound("not-valid" as any)}>
        Invalid sound
      </button>
    </>
  );
};
const TestComponentWrapper: FC = () => {
  return (
    <BrowserRouter>
      <TestComponent />
    </BrowserRouter>
  );
};

const gainNode = vi.mocked(
  {
    connect: (node: AudioNode) => node,
    gain: {
      setValueAtTime: vi.fn(),
      value: 1,
    },
  },
  true,
);
const panNode = vi.mocked(
  {
    connect: (node: AudioNode) => node,
    pan: {
      setValueAtTime: vi.fn(),
      value: 0,
    },
  },
  true,
);
/**
 * A shared audio context test instance.
 * It can also be used to mock the `AudioContext` constructor in tests:
 * `vi.stubGlobal("AudioContext", () => testAudioContext);`
 */
export const testAudioContext: Partial<AudioContext> & {
  gain: ReturnType<
    typeof vi.mocked<{
      connect: (node: AudioNode) => AudioNode;
      gain: { setValueAtTime: ReturnType<typeof vi.fn>; value: number };
    }>
  >;
  pan: ReturnType<
    typeof vi.mocked<{
      connect: (node: AudioNode) => AudioNode;
      pan: { setValueAtTime: ReturnType<typeof vi.fn>; value: number };
    }>
  >;
  setSinkId: ReturnType<typeof vi.fn>;
  decodeAudioData: ReturnType<typeof vi.fn>;
  createBufferSource: ReturnType<typeof vi.fn>;
  createGain: ReturnType<typeof vi.fn>;
  createStereoPanner: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} = {
  gain: gainNode,
  pan: panNode,
  setSinkId: vi.fn().mockResolvedValue(undefined),
  decodeAudioData: vi.fn().mockReturnValue(1),
  createBufferSource: vi.fn().mockReturnValue(
    vi.mocked({
      connect: (v: unknown) => v,
      start: () => {},
      addEventListener: (_name: string, cb: () => void) => cb(),
    }),
  ),
  createGain: vi.fn().mockReturnValue(gainNode),
  createStereoPanner: vi.fn().mockReturnValue(panNode),
  close: vi.fn().mockResolvedValue(undefined),
};

const TestAudioContext = vi.fn(
  class {
    public constructor() {
      return testAudioContext;
    }
  },
);

let user: UserEvent;
beforeEach(() => {
  window.__letroAudioOutput = {
    setSinkId: async (element, id, isCurrent) =>
      isCurrent() ? element.setSinkId(id) : Promise.resolve(),
  };
  vi.stubGlobal("AudioContext", TestAudioContext);
  user = userEvent.setup();
});

afterEach(() => {
  delete window.__letroAudioOutput;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

test("can play a single sound", async () => {
  const { findByText } = render(
    <MediaDevicesContext value={mockMediaDevices({})}>
      <TestComponentWrapper />
    </MediaDevicesContext>,
  );
  await user.click(await findByText("Valid sound"));
  expect(testAudioContext.createBufferSource).toHaveBeenCalledOnce();
});

test("will ignore sounds that are not registered", async () => {
  const { findByText } = render(
    <MediaDevicesContext value={mockMediaDevices({})}>
      <TestComponentWrapper />
    </MediaDevicesContext>,
  );
  await user.click(await findByText("Invalid sound"));
  expect(testAudioContext.createBufferSource).not.toHaveBeenCalled();
});

test("will use the correct device", () => {
  render(
    <MediaDevicesContext
      value={mockMediaDevices({
        audioOutput: {
          available$: constant(new Map<never, never>()),
          selected$: constant({ id: "chosen-device", virtualEarpiece: false }),
          select: () => {},
        },
      })}
    >
      <TestComponentWrapper />
    </MediaDevicesContext>,
  );
  expect(testAudioContext.createBufferSource).not.toHaveBeenCalled();
  expect(testAudioContext.setSinkId).toHaveBeenCalledWith("chosen-device");
});

test("will use the correct volume level", async () => {
  soundEffectVolumeSetting.setValue(0.33);
  const { findByText } = render(
    <MediaDevicesContext value={mockMediaDevices({})}>
      <TestComponentWrapper />
    </MediaDevicesContext>,
  );
  await user.click(await findByText("Valid sound"));
  expect(testAudioContext.gain.gain.setValueAtTime).toHaveBeenCalledWith(
    0.33,
    0,
  );
  expect(testAudioContext.pan.pan.setValueAtTime).toHaveBeenCalledWith(0, 0);
});

test("will use the pan if earpiece is selected", async () => {
  const { findByText } = render(
    <MediaDevicesContext
      value={mockMediaDevices({
        audioOutput: {
          available$: constant(new Map<never, never>()),
          selected$: constant({ id: "chosen-device", virtualEarpiece: true }),
          select: () => {},
        },
      })}
    >
      <TestComponentWrapper />
    </MediaDevicesContext>,
  );
  await user.click(await findByText("Valid sound"));
  expect(testAudioContext.pan.pan.setValueAtTime).toHaveBeenCalledWith(1, 0);

  expect(testAudioContext.gain.gain.setValueAtTime).toHaveBeenCalledWith(
    soundEffectVolumeSetting.getValue() * 0.1,
    0,
  );
});

test("routes tones through media element before exposing playback", async () => {
  const destination = { stream: { getTracks: () => [] }, disconnect: vi.fn() };
  const createDestination = vi.fn().mockReturnValue(destination);
  Object.assign(testAudioContext, {
    createMediaStreamDestination: createDestination,
  });
  const setSink = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", {
    value: setSink,
    configurable: true,
  });
  const connect = vi.spyOn(panNode, "connect");
  const play = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockResolvedValue(undefined);
  const pause = vi
    .spyOn(HTMLMediaElement.prototype, "pause")
    .mockImplementation(() => {});
  const view = render(
    <MediaDevicesContext
      value={mockMediaDevices({
        audioOutput: {
          available$: constant(new Map<never, never>()),
          selected$: constant({
            id: "receiver",
            sinkId: "receiver",
            virtualEarpiece: false,
          }),
          select: () => {},
        },
      })}
    >
      <TestComponentWrapper />
    </MediaDevicesContext>,
  );
  await user.click(await view.findByText("Valid sound"));
  expect(createDestination).toHaveBeenCalledOnce();
  expect(setSink).toHaveBeenCalledWith("receiver");
  expect(play).toHaveBeenCalledOnce();
  expect(connect).toHaveBeenCalledWith(destination);
  expect(testAudioContext.setSinkId).not.toHaveBeenCalled();
  view.unmount();
  expect(pause).toHaveBeenCalled();
  expect(destination.disconnect).toHaveBeenCalled();
  connect.mockRestore();
  play.mockRestore();
  pause.mockRestore();
  Reflect.deleteProperty(HTMLMediaElement.prototype, "setSinkId");
});

class RoutingErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  render(): ReactNode {
    return this.state.failed ? (
      <span>Routing failed</span>
    ) : (
      this.props.children
    );
  }
}

test("failed sink selection never exposes tone playback or plays default output", async () => {
  const destination = { stream: { getTracks: () => [] }, disconnect: vi.fn() };
  Object.assign(testAudioContext, {
    createMediaStreamDestination: vi.fn().mockReturnValue(destination),
  });
  const setSink = vi.fn().mockRejectedValue(new Error("route rejected"));
  Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", {
    value: setSink,
    configurable: true,
  });
  const play = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockResolvedValue(undefined);
  const pause = vi
    .spyOn(HTMLMediaElement.prototype, "pause")
    .mockImplementation(() => {});
  const view = render(
    <RoutingErrorBoundary>
      <MediaDevicesContext
        value={mockMediaDevices({
          audioOutput: {
            available$: constant(new Map<never, never>()),
            selected$: constant({
              id: "receiver",
              sinkId: "receiver",
              virtualEarpiece: false,
            }),
            select: () => {},
          },
        })}
      >
        <TestComponentWrapper />
      </MediaDevicesContext>
    </RoutingErrorBoundary>,
  );
  await waitFor(() => expect(destination.disconnect).toHaveBeenCalled());
  expect(await view.findByText("Routing failed")).toBeTruthy();
  expect(view.queryByText("Valid sound")).toBeNull();
  expect(play).not.toHaveBeenCalled();
  expect(testAudioContext.createBufferSource).not.toHaveBeenCalled();
  view.unmount();
  play.mockRestore();
  pause.mockRestore();
  Reflect.deleteProperty(HTMLMediaElement.prototype, "setSinkId");
});

test("unmounting during sink selection prevents late playback", async () => {
  const stopTrack = vi.fn();
  const destination = {
    stream: { getTracks: () => [{ stop: stopTrack }] },
    disconnect: vi.fn(),
  };
  Object.assign(testAudioContext, {
    createMediaStreamDestination: vi.fn().mockReturnValue(destination),
  });
  let finish!: () => void;
  const setSink = vi.fn().mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", {
    value: setSink,
    configurable: true,
  });
  const play = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockResolvedValue(undefined);
  const pause = vi
    .spyOn(HTMLMediaElement.prototype, "pause")
    .mockImplementation(() => {});
  const view = render(
    <MediaDevicesContext
      value={mockMediaDevices({
        audioOutput: {
          available$: constant(new Map<never, never>()),
          selected$: constant({
            id: "receiver",
            sinkId: "receiver",
            virtualEarpiece: false,
          }),
          select: () => {},
        },
      })}
    >
      <TestComponentWrapper />
    </MediaDevicesContext>,
  );
  await waitFor(() => expect(setSink).toHaveBeenCalled());
  expect(view.queryByText("Valid sound")).toBeNull();
  view.unmount();
  finish();
  await Promise.resolve();
  await Promise.resolve();
  expect(play).not.toHaveBeenCalled();
  expect(stopTrack).toHaveBeenCalled();
  play.mockRestore();
  pause.mockRestore();
  Reflect.deleteProperty(HTMLMediaElement.prototype, "setSinkId");
});
