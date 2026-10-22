/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";
import { type Transport } from "matrix-js-sdk/lib/matrixrtc";
import { logger } from "matrix-js-sdk/lib/logger";
import { BehaviorSubject, type Observable, Subject, throwError } from "rxjs";

import { defaultSessionTimings } from "../config";
import { type ObservableScope } from "../reactive/ObservableScope";
import { MatrixRTCError } from "../errors";
import { type HomeserverConnected } from "./HomeserverConnected";
import {
  createLocalMembership$,
  type LocalMembership,
  type PreparedTransport,
} from "./LocalMembership";
import { flushPromises, testScope } from "../utils/test";

const transport: Transport = { type: "livekit", livekit_service_url: "u" };

describe("createLocalMembership$", () => {
  it("waits for the transport, joins, and leaves on leave()", async () => {
    const { membership, homeserver, prepared$ } = setup();
    expect(membership.state$.value).toEqual({ kind: "waitingForTransport" });

    homeserver.disconnectReason$.next("membership");
    prepared$.next({ transport, canDelegateDelayedLeave: false });
    expect(membership.state$.value).toEqual({ kind: "joining" });

    homeserver.disconnectReason$.next(null);
    expect(membership.state$.value).toEqual({ kind: "joined" });

    void membership.leave();
    await flushPromises();
    expect(membership.state$.value).toEqual({ kind: "left" });
  });

  it("shares delayed departure and retains the original failed result", async () => {
    const { membership, prepared$, leave } = setup();
    const result = Promise.withResolvers<boolean>();
    leave.mockReturnValue(result.promise);
    prepared$.next({ transport, canDelegateDelayedLeave: false });
    await flushPromises();
    const first = membership.leave();
    const second = membership.leave();
    expect(membership.state$.value).toEqual({ kind: "left" });
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await flushPromises();
    expect(settled).toBe(false);
    expect(leave).toHaveBeenCalledExactlyOnceWith(10_000);
    result.resolve(false);
    expect(await Promise.all([first, second])).toEqual([false, false]);
    expect(await membership.leave()).toBe(false);
    expect(leave).toHaveBeenCalledOnce();
  });

  it.each(["during", "before", "immediately"])(
    "rejects SDK success after a membership worker error %s departure",
    async (when) => {
      const { membership, prepared$, leave, membershipManagerError$, scope } =
        setup();
      const result = Promise.withResolvers<boolean>();
      leave.mockReturnValue(result.promise);
      prepared$.next({ transport, canDelegateDelayedLeave: false });
      await flushPromises();
      if (when === "before")
        membershipManagerError$.next(new Error("worker failed"));
      const pending = membership.leave();
      scope.end();
      if (when === "immediately")
        membershipManagerError$.next(new Error("worker failed"));
      await flushPromises();
      if (when === "during")
        membershipManagerError$.next(new Error("worker failed"));
      result.resolve(true);
      expect(await pending).toBe(false);
      expect(membershipManagerError$.observed).toBe(false);
    },
  );

  it("bounds an unresponsive SDK and releases its error observer", async () => {
    const { membership, prepared$, leave, membershipManagerError$, scope } =
      setup();
    leave.mockReturnValue(new Promise<boolean>(() => {}));
    prepared$.next({ transport, canDelegateDelayedLeave: false });
    await flushPromises();
    vi.useFakeTimers();
    try {
      const pending = membership.leave();
      scope.end();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toBe(false);
      expect(membershipManagerError$.observed).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("retains SDK rejection as an unconfirmed departure", async () => {
    const { membership, prepared$, leave } = setup();
    leave.mockRejectedValue(new Error("offline"));
    prepared$.next({ transport, canDelegateDelayedLeave: false });
    await flushPromises();
    expect(await membership.leave()).toBe(false);
    expect(await membership.leave()).toBe(false);
    expect(leave).toHaveBeenCalledOnce();
  });

  it("can finish before transport discovery without entering later", async () => {
    const { membership, prepared$, leave, joinMatrixRTC } = setup();
    expect(await membership.leave()).toBe(true);
    prepared$.next({ transport, canDelegateDelayedLeave: false });
    await flushPromises();
    expect(joinMatrixRTC).not.toHaveBeenCalled();
    expect(leave).not.toHaveBeenCalled();
  });

  it("reconnects only after it was joined once", () => {
    const { membership, homeserver, prepared$ } = setup();
    prepared$.next({ transport, canDelegateDelayedLeave: false });
    expect(membership.state$.value).toEqual({ kind: "joined" });

    homeserver.disconnectReason$.next("sync");
    expect(membership.state$.value).toEqual({
      kind: "reconnecting",
      reason: "sync",
    });
    homeserver.disconnectReason$.next("probablyLeft");
    expect(membership.state$.value).toEqual({
      kind: "reconnecting",
      reason: "probablyLeft",
    });
    homeserver.disconnectReason$.next(null);
    expect(membership.state$.value).toEqual({ kind: "joined" });
  });

  it("joins with the delegated timings and hands over each delay id where the backend can", async () => {
    const { prepared$, delayId$, joinMatrixRTC, delegate } = setup();
    prepared$.next({ transport, canDelegateDelayedLeave: true });
    await flushPromises();
    expect(joinMatrixRTC).toHaveBeenCalledWith(
      transport,
      defaultSessionTimings.delegatedDelayedLeave,
    );

    delayId$.next("delay-1");
    await flushPromises();
    expect(delegate).toHaveBeenCalledWith("delay-1");
    delayId$.next("delay-2");
    await flushPromises();
    expect(delegate).toHaveBeenLastCalledWith("delay-2");
  });

  it("never hands the leave over where the backend cannot take it", async () => {
    const { prepared$, delayId$, joinMatrixRTC, delegate } = setup();
    prepared$.next({ transport, canDelegateDelayedLeave: false });
    delayId$.next("delay-1");
    await flushPromises();
    expect(joinMatrixRTC).toHaveBeenCalledWith(
      transport,
      defaultSessionTimings.delayedLeave,
    );
    expect(delegate).not.toHaveBeenCalled();
  });

  it("reports a transport that could not be prepared as failed", () => {
    const error = new MatrixRTCError("no token");
    const { membership } = setup(throwError(() => error));
    expect(membership.state$.value).toEqual({ kind: "failed", error });
  });

  it("reports the membership manager giving up as failed, and stays failed", () => {
    const { membership, homeserver, prepared$, membershipManagerError$ } =
      setup();
    prepared$.next({ transport, canDelegateDelayedLeave: false });
    membershipManagerError$.next(new Error("gave up"));
    const state = membership.state$.value;
    expect(state.kind).toBe("failed");

    homeserver.disconnectReason$.next("sync");
    homeserver.disconnectReason$.next(null);
    expect(membership.state$.value).toBe(state);
  });

  it("is left after a failure once leave() is called", () => {
    const { membership } = setup(throwError(() => new MatrixRTCError("x")));
    void membership.leave();
    expect(membership.state$.value).toEqual({ kind: "left" });
  });
});

function setup(preparedTransportWithErrors$?: Observable<PreparedTransport>): {
  membership: LocalMembership;
  homeserver: FakeHomeserverConnected;
  prepared$: Subject<PreparedTransport>;
  delayId$: BehaviorSubject<string | null>;
  membershipManagerError$: Subject<unknown>;
  joinMatrixRTC: ReturnType<typeof vi.fn>;
  delegate: ReturnType<typeof vi.fn>;
  leave: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
  scope: ObservableScope;
} {
  const prepared$ = new Subject<PreparedTransport>();
  const homeserver = fakeHomeserverConnected();
  const delayId$ = new BehaviorSubject<string | null>(null);
  const membershipManagerError$ = new Subject<unknown>();
  const joinMatrixRTC = vi.fn();
  const delegate = vi.fn(async () => Promise.resolve());
  const scope = testScope();
  const leave = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const membership = createLocalMembership$({
    scope,
    delegateDelayedLeave: delegate,
    preparedTransport$: preparedTransportWithErrors$ ?? prepared$,
    homeserverConnected: homeserver,
    joinMatrixRTC,
    membershipManagerError$,
    matrixRTCSession: { leave },
    delayId$,
    timings: defaultSessionTimings,
    logger,
  });
  return {
    membership,
    homeserver,
    prepared$,
    delayId$,
    membershipManagerError$,
    joinMatrixRTC,
    delegate,
    leave,
    scope,
  };
}

type FakeHomeserverConnected = {
  disconnectReason$: BehaviorSubject<
    HomeserverConnected["disconnectReason$"]["value"]
  >;
};

function fakeHomeserverConnected(): FakeHomeserverConnected {
  return {
    disconnectReason$: new BehaviorSubject<
      HomeserverConnected["disconnectReason$"]["value"]
    >(null),
  };
}
