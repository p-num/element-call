/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";

import { waitForCallCleanup } from "./CallCleanup";

describe("optional call cleanup", () => {
  it("waits for a short sound naturally and clears its deadline", async () => {
    vi.useFakeTimers();
    try {
      const sound = Promise.withResolvers<void>();
      let finished = false;
      const pending = waitForCallCleanup([sound.promise], 250).then(() => {
        finished = true;
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(finished).toBe(false);
      sound.resolve();
      await pending;
      expect(finished).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("bounds playback that cannot finish using its expected duration", async () => {
    vi.useFakeTimers();
    try {
      let finished = false;
      const pending = waitForCallCleanup(
        [new Promise<void>(() => {})],
        250,
      ).then(() => {
        finished = true;
      });
      await vi.advanceTimersByTimeAsync(1_249);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(finished).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("consumes failed cleanup without rejecting or waiting out the deadline", async () => {
    vi.useFakeTimers();
    try {
      await expect(
        waitForCallCleanup([
          Promise.reject(new Error("autoplay blocked")),
          undefined,
        ]),
      ).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
