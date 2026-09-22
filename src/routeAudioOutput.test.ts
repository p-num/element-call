/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/
import { afterEach, expect, it, vi } from "vitest";
import {
  routeAudioOutput,
  supportsWebKitAudioOutput,
} from "./routeAudioOutput";

vi.mock("./Platform", () => ({ platform: "ios" }));
afterEach(() => {
  Reflect.deleteProperty(window, "__letroAudioOutput");
  Reflect.deleteProperty(HTMLMediaElement.prototype, "setSinkId");
});

it("requires native routing support instead of exposing a broken output path on older hosts", () => {
  Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", {
    configurable: true,
    value: vi.fn(),
  });
  expect(supportsWebKitAudioOutput()).toBe(false);
});

it("routes through native activation even after web activation has expired", async () => {
  let nativeActivation = false;
  const element = document.createElement("audio");
  const setSinkId = vi.fn(async (_sinkId: string) =>
    nativeActivation
      ? Promise.resolve()
      : Promise.reject(
          new DOMException("A user gesture is required", "NotAllowedError"),
        ),
  );
  Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", {
    configurable: true,
    value: setSinkId,
  });
  Object.assign(window, {
    __letroAudioOutput: {
      setSinkId: async (
        target: HTMLMediaElement,
        sinkId: string,
        isCurrent: () => boolean,
      ) => {
        nativeActivation = true;
        const result = isCurrent()
          ? target.setSinkId(sinkId)
          : Promise.resolve();
        nativeActivation = false;
        return result;
      },
    },
  });
  expect(supportsWebKitAudioOutput()).toBe(true);
  await expect(routeAudioOutput(element, "receiver", () => true)).resolves.toBe(
    true,
  );
  await expect(routeAudioOutput(element, "speaker", () => true)).resolves.toBe(
    true,
  );
  expect(setSinkId.mock.calls.map((call) => call[0])).toEqual([
    "receiver",
    "speaker",
  ]);
});
