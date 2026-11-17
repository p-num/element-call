/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";
import { EventType, MatrixEvent, type Room } from "matrix-js-sdk";
import {
  CallMembership,
  type MatrixRTCSession,
} from "matrix-js-sdk/lib/matrixrtc";
import { BehaviorSubject } from "rxjs";
import {
  ErrorCode,
  PeerConnectionTimeoutError,
  type ParticipationState,
} from "@element-hq/matrixrtc-sdk";

import {
  classifyCallFailure,
  membershipIdentity,
  observeCallTelemetry,
} from "./CallTelemetry";
import { CallTelemetry, type TelemetryEvent } from "../analytics/CallTelemetry";
import {
  mockMatrixRoom,
  mockRtcMembership,
  mockRTCParticipation,
  MockRTCSession,
  testScope,
} from "../utils/test";

describe("SDK call telemetry boundaries", () => {
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

  it("uses per-join member ID only for a parsed modern sticky dialect", async () => {
    const event = new MatrixEvent({
      type: EventType.RTCMembership,
      sender: "@alice:example.org",
      event_id: "$modern",
      content: {
        slot_id: "m.call#ROOM",
        member: {
          id: "join-generation",
          user_id: "@alice:example.org",
          device_id: "AAAA",
        },
        application: { type: "m.call" },
        transports: { published: [], can_subscribe: [] },
      },
    });
    const membership = await CallMembership.parseFromEvent(event);
    expect(membershipIdentity(roomWithEvent(event), membership)).toMatchObject({
      generation: "per-join",
      memberId: "join-generation",
      slotId: "m.call#room",
    });
  });
});

function roomWithEvent(event: MatrixEvent | undefined): Room {
  return mockMatrixRoom({
    roomId: "!fixture:example.org",
    findEventById: vi.fn(() => event),
    currentState: { getStateEvents: vi.fn(() => []) } as never,
  });
}

function legacyEvent(
  membership: CallMembership,
  timestamp: number | undefined,
  eventTs: number,
): MatrixEvent {
  return new MatrixEvent({
    sender: membership.userId,
    event_id: membership.eventId,
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
