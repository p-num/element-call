/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";
import { BehaviorSubject, Subject } from "rxjs";
import { type ParticipationState } from "@element-hq/matrixrtc-sdk";

import { MatrixRTCMode } from "../../config/ConfigOptions";
import {
  type HangupReply,
  type HangupRequest,
  type HostRequest,
  nullHostBridge,
} from "../../HostBridge";
import { flushPromises } from "../../utils/test";
import { withCallViewModel } from "./CallViewModelTestUtils";

const withViewModel = withCallViewModel(MatrixRTCMode.Compatibility);

describe("call view model host integration", () => {
  it("keeps the call view alive until a correlated departure reply is delivered", async () => {
    const requests = new Subject<
      HostRequest<HangupRequest, HangupReply | void>
    >();
    const result = Promise.withResolvers<boolean>();
    const events: string[] = [];
    const reply = vi.fn(() => {
      events.push("reply");
    });
    withViewModel(
      {},
      (vm, _session, { rtcParticipation }) => {
        vi.mocked(rtcParticipation.leave).mockReturnValue(result.promise);
        vm.leave$.subscribe(() => {
          events.push("close");
        });
        requests.next({ data: { wait_for_leave: true }, reply });
      },
      { hostBridge: { ...nullHostBridge, hangUp$: requests } },
    );
    await flushPromises();
    expect(events).toEqual([]);
    result.resolve(true);
    await flushPromises();
    expect(reply).toHaveBeenCalledExactlyOnceWith({ left: true });
    expect(events).toEqual(["reply", "close"]);
  });

  it.each([undefined, null])(
    "still leaves after a legacy request with %j data",
    async (data) => {
      const requests = new Subject<
        HostRequest<HangupRequest, HangupReply | void>
      >();
      const result: string[] = [];
      const reply = vi.fn();
      withViewModel(
        {},
        (vm) => {
          vm.leave$.subscribe((reason) => {
            result.push(reason);
          });
          requests.next({ data, reply });
        },
        { hostBridge: { ...nullHostBridge, hangUp$: requests } },
      );
      expect(reply).toHaveBeenCalledExactlyOnceWith();
      await flushPromises();
      expect(result).toEqual(["user"]);
    },
  );

  it("does not confuse a join notification with actual local connection", async () => {
    const participationState$ = new BehaviorSubject<ParticipationState>({
      kind: "connecting",
    });
    const notifyJoined = vi.fn().mockResolvedValue(undefined);
    const notifyConnectionState = vi.fn().mockResolvedValue(undefined);
    withViewModel({ participationState$ }, () => {}, {
      hostBridge: { ...nullHostBridge, notifyJoined, notifyConnectionState },
    });
    expect(notifyJoined).toHaveBeenCalledOnce();
    expect(notifyConnectionState).toHaveBeenCalledExactlyOnceWith({
      connected: false,
    });
    participationState$.next({ kind: "connected" });
    participationState$.next({ kind: "connected" });
    participationState$.next({ kind: "reconnecting", reason: "media" });
    await flushPromises();
    expect(notifyConnectionState.mock.calls).toEqual([
      [{ connected: false }],
      [{ connected: true }],
      [{ connected: false }],
    ]);
  });
});
