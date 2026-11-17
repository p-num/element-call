/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";

import {
  CallTelemetry,
  type TelemetryEvent,
  type CallTelemetryOptions,
} from "./CallTelemetry";

describe("call telemetry attempt", () => {
  it("never resurrects an invalidated accepted attempt's usage, bridge or error callbacks", () => {
    let current = true;
    const bridge = vi.fn();
    const { call, events, failure } = fixture({
      isCurrent: () => current,
      reportLifecycle: bridge,
    });
    const count = events.length;
    const bridgeCount = bridge.mock.calls.length;
    current = false;
    call.connection(true);
    call.ringing();
    call.fail({
      cause: "joinTimedOut",
      stage: "homeserver",
      step: "membership",
    });
    call.end();
    expect(events).toHaveLength(count);
    expect(bridge).toHaveBeenCalledTimes(bridgeCount);
    expect(failure).not.toHaveBeenCalled();
  });

  it("gates the error callback if usage consent changes synchronously during capture", () => {
    let current = true;
    const failure = vi.fn();
    const call = new CallTelemetry({
      attemptId,
      callKind: "dm",
      componentVersion: "1",
      hostAppVersion: "1",
      hostAppBuild: "1",
      isCurrent: () => current,
      track: (event) => {
        if (event.eventName === "CallFailure") current = false;
      },
      reportFailure: failure,
    });
    call.fail({ cause: "other", stage: "media", step: "unknown" });
    expect(failure).not.toHaveBeenCalled();
  });

  it("lets the embedded host own lifecycle/linkage and uses its validated ack only for correlation", async () => {
    const hostAttemptId = "abcdef01-1234-4234-8234-123456789abc";
    const bridge = vi.fn().mockResolvedValue({ hostAttemptId });
    const { call, events } = fixture({
      lifecycleOwner: "host",
      reportLifecycle: bridge,
    });
    const digest = "a".repeat(64);
    call.correlation({
      correlationKind: "binding",
      participationId: digest,
      canonicalRoot: digest,
    });
    expect(events.map((event) => event.eventName)).toEqual([
      "CallJoinAttempted",
    ]);
    await Promise.resolve();
    call.correlation({
      correlationKind: "binding",
      participationId: digest,
      canonicalRoot: digest,
    });
    call.connection(true);
    call.end();
    expect(
      events.filter((event) => event.eventName === "CallLifecycle"),
    ).toEqual([]);
    expect(
      events.filter((event) => event.correlationKind === "attemptLink"),
    ).toEqual([]);
    expect(
      events.find((event) => event.eventName === "CallCorrelation"),
    ).toMatchObject({
      attemptId: hostAttemptId,
      eventSource: "component",
      sequence: 1,
    });
    expect(
      events
        .filter((event) =>
          [
            "CallJoinAttempted",
            "CallJoinOutcome",
            "CallParticipationEnded",
          ].includes(event.eventName),
        )
        .every((event) => event.attemptId === attemptId),
    ).toBe(true);
    expect(bridge.mock.calls.map(([report]) => report.phase)).toEqual([
      "initiation",
      "connected",
      "terminated",
    ]);
    expect(
      bridge.mock.calls.every(
        ([report]) => report.componentAttemptId === attemptId,
      ),
    ).toBe(true);
  });

  it.each([undefined, { hostAttemptId: "private-raw-id" }])(
    "fails closed on missing/invalid host ack %s without a duplicate direct lifecycle",
    async (reply) => {
      const { call, events } = fixture({
        lifecycleOwner: "host",
        reportLifecycle: vi.fn().mockResolvedValue(reply),
      });
      await Promise.resolve();
      expect(call.canCorrelate()).toBe(false);
      call.connection(true);
      call.end();
      expect(
        events.some(
          (event) =>
            event.eventName === "CallLifecycle" ||
            event.eventName === "CallCorrelation",
        ),
      ).toBe(false);
      expect(
        events.filter((event) => event.eventName === "CallJoinOutcome"),
      ).toHaveLength(1);
    },
  );

  it("uses the native event schema and local media scope without treating initiation as ringing", () => {
    const { call, events, advance } = fixture();
    expect(events.map((event) => event.eventName)).toEqual([
      "CallJoinAttempted",
      "CallLifecycle",
    ]);
    expect(events[0]).toEqual({
      eventName: "CallJoinAttempted",
      callPlatform: "web",
      callImplementation: "embedded",
      callComponentVersion: "component.1",
      attemptId,
      callKind: "dm",
    });
    advance(100);
    call.ringing();
    call.ringing();
    call.connection(true);
    call.connection(true);
    call.ringing();
    expect(phases(events)).toEqual(["initiation", "ringing", "connected"]);
    expect(events.find((event) => event.phase === "connected")).toMatchObject({
      connectionScope: "localMedia",
      elapsedMs: 100,
    });
    expect(
      events.filter((event) => event.eventName === "CallJoinOutcome"),
    ).toMatchObject([{ outcome: "connected" }]);
  });

  it("deduplicates disconnections and reconnections, then emits one connected participation end", () => {
    const { call, events, advance } = fixture();
    call.connection(false);
    advance(100);
    call.connection(true);
    advance(400);
    call.connection(false);
    call.connection(false);
    advance(200);
    call.connection(true);
    call.connection(true);
    call.participants(4);
    call.participants(2);
    call.end("othersLeft");
    const count = events.length;
    call.connection(true);
    call.ringing();
    call.fail({ cause: "other", stage: "media", step: "unknown" });
    call.end();
    expect(events).toHaveLength(count);
    expect(phases(events)).toEqual([
      "initiation",
      "connected",
      "disconnected",
      "reconnected",
      "terminated",
    ]);
    expect(
      events.find((event) => event.eventName === "CallParticipationEnded"),
    ).toMatchObject({
      endReason: "othersLeft",
      durationMs: 600,
      participantsMax: 4,
    });
    const supplementary = events.filter(
      (event) => event.eventName === "CallLifecycle",
    );
    expect(supplementary.map((event) => event.sequence)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(
      supplementary.every(
        (event) =>
          event.correlationState === "unbound" && event.sessionId === undefined,
      ),
    ).toBe(true);
  });

  it("reports typed startup timeout once, with failed outcome and no participation end", () => {
    const { call, events, failure } = fixture();
    call.fail({
      cause: "joinTimedOut",
      stage: "homeserver",
      step: "membership",
    });
    call.fail({
      cause: "joinTimedOut",
      stage: "homeserver",
      step: "membership",
    });
    call.end();
    expect(phases(events)).toEqual(["initiation", "timedOut", "terminated"]);
    expect(
      events.filter((event) => event.eventName === "CallJoinOutcome"),
    ).toMatchObject([{ outcome: "failed" }]);
    expect(
      events.filter((event) => event.eventName === "CallParticipationEnded"),
    ).toEqual([]);
    expect(failure).toHaveBeenCalledTimes(1);
    expect(failure.mock.calls[0][0]).toMatchObject({
      cause: "joinTimedOut",
      phase: "joining",
      stage: "homeserver",
      step: "membership",
    });
  });

  it("preserves the successful outcome when a connected call drops unexpectedly", () => {
    const { call, events, failure } = fixture();
    call.connection(true);
    call.fail({
      cause: "connectionLostBudget",
      stage: "media",
      step: "mediaConnection",
    });
    expect(
      events.filter((event) => event.eventName === "CallJoinOutcome"),
    ).toMatchObject([{ outcome: "connected" }]);
    expect(failure.mock.calls[0][0]).toMatchObject({
      phase: "inCall",
      cause: "connectionLostBudget",
    });
    expect(failure.mock.calls[0][0]).not.toHaveProperty("stage");
    expect(
      events.find((event) => event.eventName === "CallParticipationEnded"),
    ).toMatchObject({ endReason: "connectionLost", participantsMax: 1 });
  });

  it.each(["left", "declined", "unanswered"] as const)(
    "does not diagnose ordinary %s",
    (reason) => {
      const { call, events, failure } = fixture();
      call.end(reason);
      expect(failure).not.toHaveBeenCalled();
      const outcome = events.find(
        (event) => event.eventName === "CallJoinOutcome",
      );
      expect(outcome?.outcome).toBe("abandoned");
      expect(outcome?.endReason).toBe(reason === "left" ? undefined : reason);
      expect(
        events.some((event) => event.eventName === "CallParticipationEnded"),
      ).toBe(false);
    },
  );

  it("keeps permission refusal out of handled errors and terminates once", () => {
    const { call, events, failure } = fixture();
    call.permissionRefused();
    call.end();
    expect(failure).not.toHaveBeenCalled();
    expect(
      events.filter((event) => event.eventName === "CallJoinOutcome"),
    ).toMatchObject([{ outcome: "permissionRefused" }]);
    expect(phases(events)).toEqual(["initiation", "terminated"]);
  });

  it("adds provisional bindings without resetting the shared supplementary source sequence", () => {
    const { call, events } = fixture();
    const digest = "a".repeat(64);
    call.correlation({
      correlationKind: "binding",
      participationId: digest,
      canonicalRoot: digest,
    });
    call.connection(true);
    call.end();
    expect(
      events
        .filter((event) => event.schemaVersion === 1)
        .map((event) => event.sequence),
    ).toEqual([1, 2, 3, 4]);
    expect(events.find((event) => event.phase === "connected")).toMatchObject({
      correlationState: "provisional",
      sessionId: digest,
      eventSource: "component",
      hostAppVersion: "host.2",
      hostAppBuild: "3",
    });
  });
});

const attemptId = "12345678-1234-4234-8234-123456789abc";

function fixture(options: Partial<CallTelemetryOptions> = {}): {
  call: CallTelemetry;
  events: TelemetryEvent[];
  advance(ms: number): void;
  failure: ReturnType<typeof vi.fn>;
} {
  let now = 0;
  const events: TelemetryEvent[] = [];
  const failure = vi.fn();
  const call = new CallTelemetry({
    attemptId,
    callKind: "dm",
    componentVersion: "component.1",
    hostAppVersion: "host.2",
    hostAppBuild: "3",
    now: () => now,
    track: (event) => events.push(event),
    reportFailure: failure,
    ...options,
  });
  return {
    call,
    events,
    advance: (ms) => {
      now += ms;
    },
    failure,
  };
}

function phases(events: TelemetryEvent[]): (string | number | undefined)[] {
  return events
    .filter((event) => event.eventName === "CallLifecycle")
    .map((event) => event.phase);
}
