/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";

import { handleHostHangup, waitForHostHangup } from "./HostHangup";

describe("host-requested leave acknowledgement", () => {
  it("bounds an unresponsive departure and removes its error observer", async () => {
    vi.useFakeTimers();
    try {
      const session = {
        on: vi.fn(),
        off: vi.fn(),
        leaveRoomSession: vi.fn().mockReturnValue(new Promise(() => {})),
      };
      const reply = vi.fn();
      handleHostHangup({ data: { wait_for_leave: true }, reply }, session);
      await vi.advanceTimersByTimeAsync(10_000);
      await waitForHostHangup(session);
      expect(reply).toHaveBeenCalledExactlyOnceWith({ left: false });
      expect(session.off).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a successful Boolean after the membership worker reports failure", async () => {
    const leave = Promise.withResolvers<boolean>();
    const session = {
      on: vi.fn(),
      off: vi.fn(),
      leaveRoomSession: vi.fn().mockReturnValue(leave.promise),
    };
    const reply = vi.fn();
    handleHostHangup({ data: { wait_for_leave: true }, reply }, session);
    const failed = session.on.mock.calls[0][1];
    failed(new Error("membership send failed"));
    leave.resolve(true);
    await waitForHostHangup(session);
    expect(reply).toHaveBeenCalledExactlyOnceWith({ left: false });
    expect(session.off).toHaveBeenCalledWith(
      session.on.mock.calls[0][0],
      failed,
    );
  });

  it("still waits for leave when another cleanup operation fails", async () => {
    const leave = Promise.withResolvers<boolean>();
    const session = {
      on: vi.fn(),
      off: vi.fn(),
      leaveRoomSession: vi.fn().mockReturnValue(leave.promise),
    };
    const reply = vi.fn();
    handleHostHangup({ data: { wait_for_leave: true }, reply }, session);
    let canClose = false;
    const closing = waitForHostHangup(session, [
      Promise.reject(new Error("audio failed")),
    ]).then(() => {
      canClose = true;
    });
    await Promise.resolve();
    expect(canClose).toBe(false);
    leave.resolve(true);
    await closing;
    expect(reply).toHaveBeenCalledExactlyOnceWith({ left: true });
    expect(canClose).toBe(true);
  });
  it("keeps the transport open and does not acknowledge before leave completes", async () => {
    const leave = Promise.withResolvers<boolean>();
    const session = {
      on: vi.fn(),
      off: vi.fn(),
      leaveRoomSession: vi.fn().mockReturnValue(leave.promise),
    };
    const reply = vi.fn();
    handleHostHangup({ data: { wait_for_leave: true }, reply }, session);
    let canClose = false;
    const closing = waitForHostHangup(session).then(() => {
      canClose = true;
    });
    await Promise.resolve();
    expect(reply).not.toHaveBeenCalled();
    expect(canClose).toBe(false);
    leave.resolve(true);
    await closing;
    expect(reply).toHaveBeenCalledExactlyOnceWith({ left: true });
    expect(session.leaveRoomSession).toHaveBeenCalledExactlyOnceWith(10_000);
  });

  it.each([false, "throw"])(
    "does not claim successful leave after %s",
    async (result) => {
      const session = {
        on: vi.fn(),
        off: vi.fn(),
        leaveRoomSession:
          result === "throw"
            ? vi.fn().mockRejectedValue(new Error("offline"))
            : vi.fn().mockResolvedValue(false),
      };
      const reply = vi.fn();
      handleHostHangup({ data: { wait_for_leave: true }, reply }, session);
      await waitForHostHangup(session);
      expect(reply).toHaveBeenCalledExactlyOnceWith({ left: false });
    },
  );

  it("shares the leave operation across repeated requests", async () => {
    const leave = Promise.withResolvers<boolean>();
    const session = {
      on: vi.fn(),
      off: vi.fn(),
      leaveRoomSession: vi.fn().mockReturnValue(leave.promise),
    };
    const first = vi.fn();
    const second = vi.fn();
    handleHostHangup({ data: { wait_for_leave: true }, reply: first }, session);
    handleHostHangup(
      { data: { wait_for_leave: true }, reply: second },
      session,
    );
    leave.resolve(true);
    await waitForHostHangup(session);
    expect(session.leaveRoomSession).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledExactlyOnceWith({ left: true });
    expect(second).toHaveBeenCalledExactlyOnceWith({ left: true });
  });

  it("does not reuse a previous call's result when the session object is reused", async () => {
    const session = {
      on: vi.fn(),
      off: vi.fn(),
      leaveRoomSession: vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
    };
    const first = vi.fn();
    handleHostHangup({ data: { wait_for_leave: true }, reply: first }, session);
    await waitForHostHangup(session);
    const second = vi.fn();
    handleHostHangup(
      { data: { wait_for_leave: true }, reply: second },
      session,
    );
    await waitForHostHangup(session);
    expect(session.leaveRoomSession).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledExactlyOnceWith({ left: false });
  });

  it("preserves immediate acknowledgements for hosts that did not request the result", () => {
    const session = {
      on: vi.fn(),
      off: vi.fn(),
      leaveRoomSession: vi.fn(),
    };
    const reply = vi.fn();
    handleHostHangup({ data: {}, reply }, session);
    expect(reply).toHaveBeenCalledExactlyOnceWith();
    expect(session.leaveRoomSession).not.toHaveBeenCalled();
  });
});
