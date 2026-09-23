/*
Copyright 2026 Element Corp.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Observable, BehaviorSubject, of } from "rxjs";

import { ObservableScope } from "./ObservableScope";
import { constant } from "./Behavior";
import { type SelectedAudioOutputDevice } from "./MediaDevices";
import {
  availableOutputDevices$,
  type Controls,
  type OutputDevice,
  outputDevice$,
} from "../controls";
import {
  EARPIECE_CONFIG_ID,
  IOSControlledAudioOutput,
} from "./IOSControlledAudioOutput";

// `vi.mock` calls are hoisted above all imports, so the static imports below
// already see these mocks. Force the iOS platform so that the virtual earpiece
// is available, and stub the livekit device observer (only subscribed for its
// side effects).
vi.mock("../Platform", () => ({ platform: "ios" }));
const browser = vi.hoisted(() => ({
  devices: null as unknown as BehaviorSubject<MediaDeviceInfo[]>,
}));
vi.mock("@livekit/components-core", () => ({
  createMediaDeviceObserver: (): Observable<MediaDeviceInfo[]> =>
    browser.devices ?? of([]),
}));

// On iOS the host reports a single device for the current route. When output is
// on the loudspeaker it is flagged `forEarpiece`, which makes the controller
// expose a virtual earpiece device.
const SPEAKER: OutputDevice = {
  id: "speaker",
  name: "Speaker",
  isSpeaker: true,
  forEarpiece: true,
};

// A connected headset (e.g. Bluetooth) is reported as a plain named device,
// with neither the speaker nor earpiece flag set.
const HEADSET: OutputDevice = {
  id: "bt",
  name: "AirPods",
};

let testScope: ObservableScope;

beforeEach(() => {
  testScope = new ObservableScope();
  window.controls = {
    onAudioDeviceSelect: vi.fn(),
    onOutputDeviceSelect: vi.fn(),
  } as unknown as Controls;
});

afterEach(() => {
  testScope.end();
});

/**
 * Subscribe to the controller's `selected$` and return a getter for the latest
 * emitted value.
 */
function latestSelection(
  output: InstanceType<typeof IOSControlledAudioOutput>,
): () => SelectedAudioOutputDevice | undefined {
  let latest: SelectedAudioOutputDevice | undefined;
  output.selected$.subscribe((s) => {
    latest = s;
  });
  return () => latest;
}

describe("Default selection", () => {
  it("defaults to the earpiece for voice (audio) calls", () => {
    const output = new IOSControlledAudioOutput(
      constant(false),
      testScope,
      "audio",
    );
    const selected = latestSelection(output);

    availableOutputDevices$.next([SPEAKER]);

    expect(selected()).toEqual({
      id: EARPIECE_CONFIG_ID,
      virtualEarpiece: true,
    });
    expect(window.controls.onAudioDeviceSelect).toHaveBeenLastCalledWith(
      EARPIECE_CONFIG_ID,
    );
  });

  it("defaults to the speaker for video calls", () => {
    const output = new IOSControlledAudioOutput(
      constant(false),
      testScope,
      "video",
    );
    const selected = latestSelection(output);

    availableOutputDevices$.next([SPEAKER]);

    expect(selected()).toEqual({ id: SPEAKER.id, virtualEarpiece: false });
  });

  it("keeps a headset for voice calls instead of forcing the earpiece", () => {
    const output = new IOSControlledAudioOutput(
      constant(false),
      testScope,
      "audio",
    );
    const selected = latestSelection(output);

    // The host proposes the headset as the route (listed first), even though a
    // forEarpiece device is also present so the virtual earpiece exists.
    availableOutputDevices$.next([HEADSET, SPEAKER]);

    expect(selected()).toEqual({ id: HEADSET.id, virtualEarpiece: false });
  });
});

describe("Explicit selection", () => {
  it("an explicit user selection overrides the earpiece default", () => {
    const output = new IOSControlledAudioOutput(
      constant(false),
      testScope,
      "audio",
    );
    const selected = latestSelection(output);

    availableOutputDevices$.next([SPEAKER]);
    // Earpiece by default for a voice call...
    expect(selected()).toEqual({
      id: EARPIECE_CONFIG_ID,
      virtualEarpiece: true,
    });

    // ...until the user explicitly picks the speaker.
    output.select(SPEAKER.id);
    expect(selected()).toEqual({ id: SPEAKER.id, virtualEarpiece: false });
  });

  it("a host selection overrides the earpiece default", () => {
    const output = new IOSControlledAudioOutput(
      constant(false),
      testScope,
      "audio",
    );
    const selected = latestSelection(output);

    availableOutputDevices$.next([SPEAKER]);
    outputDevice$.next(SPEAKER.id);

    expect(selected()).toEqual({ id: SPEAKER.id, virtualEarpiece: false });
  });
});

describe("WebKit output selection", () => {
  const receiver = {
    deviceId: "web-receiver",
    label: "Receiver",
    kind: "audiooutput",
  } as MediaDeviceInfo;
  const speaker = {
    deviceId: "web-speaker",
    label: "Speaker",
    kind: "audiooutput",
  } as MediaDeviceInfo;
  const defaultSpeaker = {
    deviceId: "default",
    label: "Default - Speaker",
    kind: "audiooutput",
  } as MediaDeviceInfo;
  beforeEach(() => {
    window.__letroAudioOutput = {
      setSinkId: vi.fn().mockResolvedValue(undefined),
    };
    browser.devices = new BehaviorSubject<MediaDeviceInfo[]>([]);
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", {
      configurable: true,
      value: vi.fn(),
    });
  });
  afterEach(() => {
    delete window.__letroAudioOutput;
    delete (HTMLMediaElement.prototype as Partial<HTMLMediaElement>).setSinkId;
    browser.devices = null!;
  });
  it("retains legacy selection when an older host exposes the browser API without a routing bridge", () => {
    delete window.__letroAudioOutput;
    const output = new IOSControlledAudioOutput(
      constant(false),
      testScope,
      "audio",
    );
    availableOutputDevices$.next([SPEAKER]);
    expect(output.selected$.value).toEqual({
      id: EARPIECE_CONFIG_ID,
      virtualEarpiece: true,
    });
  });
  it("waits for enumeration, then selects a real receiver without virtual gain", () => {
    const output = new IOSControlledAudioOutput(
      constant(false),
      testScope,
      "audio",
    );
    availableOutputDevices$.next([SPEAKER]);
    expect(output.selected$.value).toBeUndefined();
    browser.devices.next([defaultSpeaker, speaker, receiver]);
    expect(output.selected$.value).toEqual({
      id: receiver.deviceId,
      sinkId: receiver.deviceId,
      virtualEarpiece: false,
    });
    expect(output.available$.value.has(EARPIECE_CONFIG_ID)).toBe(false);
    expect(window.controls.onOutputDeviceSelect).toHaveBeenLastCalledWith(
      EARPIECE_CONFIG_ID,
    );
    output.select(speaker.deviceId);
    outputDevice$.next("native-uid");
    availableOutputDevices$.next([SPEAKER]);
    expect(output.selected$.value?.sinkId).toBe(speaker.deviceId);
  });
  it("keeps the system headset default and replaces disconnected choices", () => {
    browser.devices.next([
      { ...defaultSpeaker, label: "Default - Headphones" },
      speaker,
      receiver,
    ]);
    const output = new IOSControlledAudioOutput(
      constant(false),
      testScope,
      "audio",
    );
    expect(output.selected$.value?.sinkId).toBe("default");
    output.select(receiver.deviceId);
    browser.devices.next([speaker]);
    expect(output.selected$.value?.sinkId).toBe(speaker.deviceId);
  });
  it("keeps unknown labels selectable without guessing which is the receiver", () => {
    browser.devices.next([{ ...receiver, label: "Unknown output" }]);
    const output = new IOSControlledAudioOutput(
      constant(false),
      testScope,
      "video",
    );
    expect(output.available$.value.get(receiver.deviceId)).toEqual({
      type: "name",
      name: "Unknown output",
    });
    expect(output.selected$.value?.sinkId).toBe(receiver.deviceId);
  });
});
