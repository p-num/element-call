/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";

import { handleHostHangup } from "./HostHangup";

describe("host-requested leave acknowledgement", () => {
  it("does not acknowledge before the participation confirms departure", async () => {
    const departure = Promise.withResolvers<boolean>();
    const participation = { leave: vi.fn(async () => departure.promise) };
    const reply = vi.fn();
    const pending = handleHostHangup(
      { data: { wait_for_leave: true }, reply },
      participation,
    );
    await Promise.resolve();
    expect(reply).not.toHaveBeenCalled();
    departure.resolve(true);
    await pending;
    expect(reply).toHaveBeenCalledExactlyOnceWith({ left: true });
  });

  it("does not authorize a switch after unconfirmed departure", async () => {
    const participation = { leave: vi.fn().mockResolvedValue(false) };
    const reply = vi.fn();
    await handleHostHangup(
      { data: { wait_for_leave: true }, reply },
      participation,
    );
    expect(reply).toHaveBeenCalledExactlyOnceWith({ left: false });
  });

  it.each([undefined, null, {}, { wait_for_leave: false }])(
    "preserves immediate legacy acknowledgements for %j",
    async (data) => {
      const participation = { leave: vi.fn() };
      const reply = vi.fn();
      const pending = handleHostHangup({ data, reply }, participation);
      expect(reply).toHaveBeenCalledExactlyOnceWith();
      expect(participation.leave).not.toHaveBeenCalled();
      await pending;
    },
  );
});
