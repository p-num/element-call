/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, EventType, MatrixEvent, Room } from "matrix-js-sdk";
import {
  CallMembership,
  type MatrixRTCSession,
} from "matrix-js-sdk/lib/matrixrtc";
import { BehaviorSubject } from "rxjs";
import {
  ErrorCode,
  type InitialMicrophonePublication,
  PeerConnectionTimeoutError,
  type ParticipationState,
} from "@element-hq/matrixrtc-sdk";

import {
  classifyCallFailure,
  createCallTelemetry,
  membershipIdentity,
  observeCallTelemetry,
} from "./CallTelemetry";
import { CallTelemetry, type TelemetryEvent } from "../analytics/CallTelemetry";
import { PosthogAnalytics } from "../analytics/PosthogAnalytics";
import { nullHostBridge } from "../HostBridge";
import {
  mockMatrixRoom,
  mockRtcMembership,
  mockRTCParticipation,
  MockRTCSession,
  testScope,
} from "../utils/test";

describe("SDK call telemetry boundaries", () => {
  it.each([
    [new DOMException("refused", "NotAllowedError"), "permissionRefused"],
    [new Error("publication failed"), "failed"],
  ])(
    "gates the connected outcome on required microphone publication: %s",
    (error, outcome) => {
      const scope = testScope();
      const microphone = new BehaviorSubject<InitialMicrophonePublication>({
        kind: "pending",
      });
      const participation = mockRTCParticipation(scope, {
        initialMicrophonePublication$: microphone,
      });
      const room = mockMatrixRoom({});
      const events: TelemetryEvent[] = [];
      const failures = vi.fn();
      const telemetry = new CallTelemetry({
        callKind: "dm",
        componentVersion: "test",
        hostAppVersion: "test",
        hostAppBuild: "test",
        track: (event) => events.push(event),
        reportFailure: failures,
      });
      observeCallTelemetry(
        scope,
        telemetry,
        participation,
        new MockRTCSession(room) as unknown as MatrixRTCSession,
        room,
      );
      expect(
        events.filter((event) => event.eventName === "CallJoinOutcome"),
      ).toEqual([]);
      microphone.next({ kind: "failed", error });
      expect(
        events
          .filter((event) => event.eventName === "CallJoinOutcome")
          .map((event) => event.outcome),
      ).toEqual([outcome]);
      expect(events.some((event) => event.phase === "connected")).toBe(false);
      if (outcome === "failed") {
        expect(failures).toHaveBeenCalledWith(
          expect.objectContaining({
            cause: "microphoneFailed",
            phase: "joining",
          }),
        );
        expect(
          events.filter((event) => event.eventName === "CallFailure"),
        ).toHaveLength(1);
      } else expect(failures).not.toHaveBeenCalled();
      microphone.next({ kind: "published" });
      scope.end();
      expect(
        events.filter((event) => event.eventName === "CallJoinOutcome"),
      ).toHaveLength(1);
    },
  );

  it("connects only when the required microphone succeeds and preserves reconnection after later mute", () => {
    const scope = testScope();
    const microphone = new BehaviorSubject<InitialMicrophonePublication>({
      kind: "pending",
    });
    const states = new BehaviorSubject<ParticipationState>({
      kind: "connected",
    });
    const participation = mockRTCParticipation(scope, {
      state$: states,
      initialMicrophonePublication$: microphone,
    });
    const room = mockMatrixRoom({});
    const events: TelemetryEvent[] = [];
    const telemetry = new CallTelemetry({
      callKind: "dm",
      componentVersion: "test",
      hostAppVersion: "test",
      hostAppBuild: "test",
      track: (event) => events.push(event),
    });
    observeCallTelemetry(
      scope,
      telemetry,
      participation,
      new MockRTCSession(room) as unknown as MatrixRTCSession,
      room,
    );
    expect(
      events.filter((event) => event.eventName === "CallJoinOutcome"),
    ).toEqual([]);
    microphone.next({ kind: "published" });
    states.next({ kind: "reconnecting", reason: "media" });
    states.next({ kind: "connected" });
    scope.end();
    expect(
      events
        .filter((event) => event.eventName === "CallJoinOutcome")
        .map((event) => event.outcome),
    ).toEqual(["connected"]);
    expect(
      events
        .filter((event) => event.eventName === "CallLifecycle")
        .map((event) => event.phase),
    ).toEqual([
      "initiation",
      "connected",
      "disconnected",
      "reconnected",
      "terminated",
    ]);
  });

  it("records initial connection states and synchronously ends before scope teardown", () => {
    const scope = testScope();
    const states = new BehaviorSubject<ParticipationState>({
      kind: "waitingForTransport",
    });
    const participation = mockRTCParticipation(scope, { state$: states });
    const room = mockMatrixRoom({ roomId: "!test:example.org" });
    const session = new MockRTCSession(room);
    const events: TelemetryEvent[] = [];
    const telemetry = new CallTelemetry({
      callKind: "group",
      componentVersion: "test",
      hostAppVersion: "test",
      hostAppBuild: "test",
      track: (event) => events.push(event),
    });
    observeCallTelemetry(
      scope,
      telemetry,
      participation,
      session as unknown as MatrixRTCSession,
      room,
    );
    states.next({ kind: "connecting" });
    expect(events.some((event) => event.phase === "connected")).toBe(false);
    states.next({ kind: "connected" });
    states.next({ kind: "reconnecting", reason: "media" });
    states.next({ kind: "connected" });
    scope.end();
    expect(
      events
        .filter((event) => event.eventName === "CallLifecycle")
        .map((event) => event.phase),
    ).toEqual([
      "initiation",
      "connected",
      "disconnected",
      "reconnected",
      "terminated",
    ]);
    expect(
      events.filter((event) => event.eventName === "CallParticipationEnded"),
    ).toHaveLength(1);
  });

  it("classifies typed errors without looking at their messages", () => {
    expect(classifyCallFailure(new PeerConnectionTimeoutError()).cause).toBe(
      "joinTimedOut",
    );
    expect(
      classifyCallFailure({ code: ErrorCode.MISSING_MATRIX_RTC_TRANSPORT }),
    ).toEqual({
      cause: "noMediaServer",
      stage: "homeserver",
      step: "transportDiscovery",
    });
    expect(
      classifyCallFailure({
        code: ErrorCode.OPEN_ID_ERROR,
        message: "private-token",
      } as never),
    ).toEqual({ cause: "other", stage: "media", step: "mediaToken" });
  });
});

describe("host call telemetry capability", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([undefined, false, true])(
    "selects lifecycle ownership from explicit capability %s",
    async (enabled) => {
      const events: TelemetryEvent[] = [];
      vi.spyOn(PosthogAnalytics.instance, "callLifetime").mockReturnValue(
        () => true,
      );
      vi.spyOn(PosthogAnalytics.instance, "trackCallEvent").mockImplementation(
        (event) => {
          events.push(event);
        },
      );
      const notifyCallTelemetry = vi
        .fn()
        .mockRejectedValue(new Error("unsupported custom action"));
      const telemetry = createCallTelemetry(
        { getAccountData: () => undefined } as never,
        mockMatrixRoom({}),
        { ...nullHostBridge, notifyCallTelemetry },
        enabled,
      );
      telemetry.connection(true);
      telemetry.end();
      await Promise.resolve();
      if (enabled) {
        expect(notifyCallTelemetry).toHaveBeenCalled();
        expect(
          events.filter((event) => event.eventName === "CallLifecycle"),
        ).toEqual([]);
      } else {
        expect(notifyCallTelemetry).not.toHaveBeenCalled();
        expect(
          events
            .filter((event) => event.eventName === "CallLifecycle")
            .map((event) => event.phase),
        ).toEqual(["initiation", "connected", "terminated"]);
      }
      expect(
        events.filter((event) => event.eventName === "CallJoinOutcome"),
      ).toHaveLength(1);
    },
  );

  it("keeps component lifecycle when the flag is true but the bridge lacks the action", () => {
    const events: TelemetryEvent[] = [];
    vi.spyOn(PosthogAnalytics.instance, "callLifetime").mockReturnValue(
      () => true,
    );
    vi.spyOn(PosthogAnalytics.instance, "trackCallEvent").mockImplementation(
      (event) => {
        events.push(event);
      },
    );
    createCallTelemetry(
      { getAccountData: () => undefined } as never,
      mockMatrixRoom({}),
      nullHostBridge,
      true,
    ).end();
    expect(
      events.filter((event) => event.eventName === "CallLifecycle"),
    ).toHaveLength(2);
  });
});

describe("verified participation generation", () => {
  it("uses explicit legacy generation, normalizes the slot, and ignores refresh event timestamps", () => {
    const membership = mockRtcMembership("@alice:example.org", "AAAA", {
      membership: { created_ts: 1234567890 },
    });
    const event = legacyEvent(membership, 1234567890, 9999999999);
    const room = roomWithEvent(event);
    expect(membershipIdentity(room, membership)).toMatchObject({
      slotId: "m.call#room",
      generation: "legacy:1234567890",
      memberId: membership.memberId,
    });
    const refreshed = legacyEvent(membership, 1234567890, 99999999999);
    expect(membershipIdentity(roomWithEvent(refreshed), membership)).toEqual(
      membershipIdentity(room, membership),
    );
  });

  it.each([undefined, -1, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    "keeps unavailable/invalid legacy generation %s unbound",
    (timestamp) => {
      const membership = mockRtcMembership("@alice:example.org", "AAAA");
      expect(
        membershipIdentity(
          roomWithEvent(legacyEvent(membership, timestamp, 9999999999)),
          membership,
        ),
      ).toBeUndefined();
    },
  );

  it("keeps a membership without its verifiable source event unbound", () => {
    const membership = mockRtcMembership("@alice:example.org", "AAAA");
    expect(
      membershipIdentity(roomWithEvent(undefined), membership),
    ).toBeUndefined();
  });

  describe("the pinned SDK active sticky store", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-11-17T12:00:00Z"));
    });
    afterEach(() => {
      vi.clearAllTimers();
      vi.useRealTimers();
    });

    it("resolves modern per-join identity when a real Room has no matching timeline event", async () => {
      const room = stickyRoom();
      const event = modernStickyEvent("$modern", "join-generation");
      room._unstable_addStickyEvents([event]);
      const membership = await CallMembership.parseFromEvent(event);
      expect(room.findEventById(event.getId()!)).toBeUndefined();
      expect([...room._unstable_getStickyEvents()]).toEqual([event]);
      expect(membershipIdentity(room, membership)).toMatchObject({
        generation: "per-join",
        memberId: "join-generation",
        slotId: "m.call#room",
      });
    });

    it("does not substitute another active event with the same sender/device/member for an exact-ID miss", async () => {
      const room = stickyRoom();
      const missing = modernStickyEvent("$missing", "join-generation");
      const active = modernStickyEvent("$active", "join-generation");
      room._unstable_addStickyEvents([active]);
      const membership = await CallMembership.parseFromEvent(missing);
      expect([...room._unstable_getStickyEvents()]).toEqual([active]);
      expect(membershipIdentity(room, membership)).toBeUndefined();
    });

    it("resolves only the current keyed sticky event after replacement", async () => {
      const room = stickyRoom();
      const original = modernStickyEvent("$original", "first-join");
      room._unstable_addStickyEvents([original]);
      const previous = await CallMembership.parseFromEvent(original);
      vi.advanceTimersByTime(1);
      const replacement = modernStickyEvent("$replacement", "next-join");
      room._unstable_addStickyEvents([replacement]);
      const current = await CallMembership.parseFromEvent(replacement);
      expect(room.findEventById(original.getId()!)).toBeUndefined();
      expect(room.findEventById(replacement.getId()!)).toBeUndefined();
      expect([...room._unstable_getStickyEvents()]).toEqual([replacement]);
      expect(membershipIdentity(room, previous)).toBeUndefined();
      expect(membershipIdentity(room, current)).toMatchObject({
        generation: "per-join",
        memberId: "next-join",
      });
    });

    it("keeps missing legacy generation unbound despite a timestamped sticky membership for the same device", () => {
      const room = stickyRoom();
      const membership = mockRtcMembership("@alice:example.org", "AAAA");
      room.currentState.setStateEvents([
        legacyEvent(membership, undefined, Date.now()),
      ]);
      room._unstable_addStickyEvents([
        modernStickyEvent("$other-participation", membership.memberId),
      ]);
      expect([...room._unstable_getStickyEvents()]).toHaveLength(1);
      expect(
        room.currentState.getStateEvents(EventType.GroupCallMemberPrefix),
      ).toHaveLength(1);
      expect(membershipIdentity(room, membership)).toBeUndefined();
    });
  });
});

function roomWithEvent(event: MatrixEvent | undefined): Room {
  return mockMatrixRoom({
    roomId: "!fixture:example.org",
    findEventById: vi.fn(() => event),
    _unstable_getStickyEvents: vi.fn(() => []),
    currentState: { getStateEvents: vi.fn(() => []) } as never,
  });
}

function legacyEvent(
  membership: CallMembership,
  timestamp: number | undefined,
  eventTs: number,
): MatrixEvent {
  return new MatrixEvent({
    room_id: "!fixture:example.org",
    sender: membership.userId,
    event_id: membership.eventId,
    state_key: membership.userId,
    type: EventType.GroupCallMemberPrefix,
    origin_server_ts: eventTs,
    content: {
      application: "m.call",
      call_id: "",
      device_id: membership.deviceId,
      focus_active: { type: "livekit", focus_selection: "multi_sfu" },
      foci_preferred: [],
      ...(timestamp === undefined ? {} : { created_ts: timestamp }),
    },
  });
}

function stickyRoom(): Room {
  const client = createClient({
    baseUrl: "https://example.org",
    userId: "@alice:example.org",
  });
  return new Room("!fixture:example.org", client, "@alice:example.org");
}

function modernStickyEvent(eventId: string, memberId: string): MatrixEvent {
  return new MatrixEvent({
    type: EventType.RTCMembership,
    room_id: "!fixture:example.org",
    sender: "@alice:example.org",
    event_id: eventId,
    origin_server_ts: Date.now(),
    msc4354_sticky: { duration_ms: 60_000 },
    content: {
      msc4354_sticky_key: "AAAA",
      slot_id: "m.call#ROOM",
      member: {
        id: memberId,
        user_id: "@alice:example.org",
        device_id: "AAAA",
      },
      application: { type: "m.call" },
      transports: { published: [], can_subscribe: [] },
    },
  });
}
