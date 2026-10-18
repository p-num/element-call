/*
Copyright 2026 Element Creations Ltd.
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { describe, it, expect, vi } from "vitest";
import { Subject } from "rxjs";
import { observeHostConnection } from "./HostConnection";

describe("host connection reports", () => {
  it("reports connection transitions, suppresses duplicates and stops with the call", () => {
    const connected = new Subject<boolean>();
    const notify = vi.fn().mockResolvedValue(undefined);
    const subscription = observeHostConnection(connected, notify);
    connected.next(false);
    connected.next(false);
    connected.next(true);
    connected.next(false);
    subscription.unsubscribe();
    connected.next(true);
    expect(notify.mock.calls).toEqual([
      [{ connected: false }],
      [{ connected: true }],
      [{ connected: false }],
    ]);
  });

  it("supports hosts without the extension", () => {
    const connected = new Subject<boolean>();
    const subscription = observeHostConnection(connected, undefined);
    expect(() => connected.next(true)).not.toThrow();
    subscription.unsubscribe();
  });

  it("keeps observing after a host rejects a notification", async () => {
    const connected = new Subject<boolean>();
    const notify = vi.fn().mockRejectedValue(new Error("unsupported"));
    const subscription = observeHostConnection(connected, notify);
    connected.next(true);
    await Promise.resolve();
    connected.next(false);
    await Promise.resolve();
    expect(notify).toHaveBeenCalledTimes(2);
    subscription.unsubscribe();
  });
});
