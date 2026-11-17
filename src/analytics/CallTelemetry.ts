/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type CorrelationUpdate } from "./ParticipationGraph";

export type CallPhase =
  | "initiation"
  | "ringing"
  | "connected"
  | "disconnected"
  | "reconnected"
  | "failed"
  | "timedOut"
  | "terminated";
export type EndReason =
  | "left"
  | "othersLeft"
  | "declined"
  | "unanswered"
  | "ringNotSent"
  | "empty"
  | "slotClosed"
  | "connectionLost";
export type CallReason =
  | EndReason
  | "failed"
  | "permissionRefused"
  | "abandoned"
  | "replaced"
  | "widgetSetupFailed"
  | "joinTimedOut"
  | "widgetLoadTimedOut"
  | "webContentProcessTerminated"
  | "componentEnded";
export type FailureCause =
  | "joinTimedOut"
  | "joinRefused"
  | "slotClosed"
  | "noMediaServer"
  | "tokenEndpointUnsupported"
  | "connectionLostNeverConnected"
  | "connectionLostRefused"
  | "connectionLostBudget"
  | "microphoneFailed"
  | "other";
export type Failure = {
  cause: FailureCause;
  stage: "homeserver" | "media";
  step:
    | "transportDiscovery"
    | "membership"
    | "mediaToken"
    | "mediaConnection"
    | "unknown";
};
export type LifecycleReport = {
  phase: CallPhase;
  reason?: CallReason;
  componentAttemptId: string;
};
export type TelemetryEvent = {
  eventName: string;
  [key: string]: string | number | undefined;
};

export interface CallTelemetryOptions {
  callKind: "dm" | "group";
  componentVersion: string;
  hostAppVersion: string;
  hostAppBuild: string;
  track(event: TelemetryEvent): void;
  reportLifecycle?(report: LifecycleReport): void;
  reportFailure?(event: TelemetryEvent): void;
  now?(): number;
  attemptId?: string;
}

/** One join attempt; the clock and sinks are owned by the caller, never by the page. */
export class CallTelemetry {
  private readonly now: () => number;
  private readonly started: number;
  private readonly common: TelemetryEvent;
  private sequence = 0;
  private terminal = false;
  private rang = false;
  private connectedAt: number | undefined;
  private disconnected = false;
  private participantsMax = 1;
  private sessionId: string | undefined;

  public constructor(private readonly options: CallTelemetryOptions) {
    this.now = options.now ?? (() => performance.now());
    this.started = this.now();
    this.common = {
      eventName: "",
      callImplementation: "embedded",
      callPlatform: "web",
      callComponentVersion: options.componentVersion,
      attemptId: options.attemptId ?? crypto.randomUUID(),
      callKind: options.callKind,
    };
    this.track("CallJoinAttempted");
    this.lifecycle("initiation");
  }

  public ringing(): void {
    if (this.terminal || this.rang || this.connectedAt !== undefined) return;
    this.rang = true;
    this.lifecycle("ringing");
  }

  public connection(connected: boolean): void {
    if (this.terminal) return;
    if (connected) {
      if (this.connectedAt === undefined) {
        this.connectedAt = this.now();
        this.track("CallJoinOutcome", { outcome: "connected" });
        this.lifecycle("connected");
      } else if (this.disconnected) {
        this.lifecycle("reconnected");
      }
      this.disconnected = false;
    } else if (this.connectedAt !== undefined && !this.disconnected) {
      this.disconnected = true;
      this.lifecycle("disconnected", "connectionLost");
    }
  }

  public participants(count: number): void {
    if (!this.terminal && Number.isSafeInteger(count))
      this.participantsMax = Math.max(this.participantsMax, count);
  }

  public correlation(update: CorrelationUpdate): void {
    if (this.terminal) return;
    this.sessionId = update.canonicalRoot;
    this.options.track({
      ...this.supplementary(),
      ...update,
      eventName: "CallCorrelation",
    });
  }

  public fail(failure: Failure): void {
    if (this.terminal) return;
    const phase = this.connectedAt === undefined ? "joining" : "inCall";
    const event = {
      ...this.common,
      eventName: "CallFailure",
      cause: failure.cause,
      phase,
      ...(phase === "joining"
        ? { stage: failure.stage, step: failure.step }
        : {}),
    };
    this.options.track(event);
    this.options.reportFailure?.(event);
    if (this.connectedAt === undefined)
      this.track("CallJoinOutcome", { outcome: "failed" });
    this.lifecycle(
      failure.cause === "joinTimedOut" ? "timedOut" : "failed",
      failure.cause === "joinTimedOut" ? "joinTimedOut" : "failed",
    );
    this.finish(
      this.connectedAt === undefined ? undefined : "connectionLost",
      "failed",
    );
  }

  public end(reason: EndReason = "left"): void {
    if (this.terminal) return;
    if (this.connectedAt === undefined) {
      this.track("CallJoinOutcome", {
        outcome: "abandoned",
        ...(reason === "left" ? {} : { endReason: reason }),
      });
      if (reason === "unanswered") this.lifecycle("timedOut", reason);
    }
    this.finish(reason, reason);
  }

  public permissionRefused(): void {
    if (this.terminal) return;
    if (this.connectedAt === undefined)
      this.track("CallJoinOutcome", { outcome: "permissionRefused" });
    this.finish(
      this.connectedAt === undefined ? undefined : "left",
      "permissionRefused",
    );
  }

  private finish(endReason: EndReason | undefined, reason: CallReason): void {
    if (this.connectedAt !== undefined)
      this.track("CallParticipationEnded", {
        endReason: endReason ?? "left",
        durationMs: Math.max(0, Math.floor(this.now() - this.connectedAt)),
        participantsMax: this.participantsMax,
      });
    this.lifecycle("terminated", reason);
    this.terminal = true;
  }

  private lifecycle(phase: CallPhase, reason?: CallReason): void {
    this.options.track({
      ...this.supplementary(),
      eventName: "CallLifecycle",
      phase,
      ...(reason === undefined ? {} : { reason }),
      ...(phase === "connected" || phase === "reconnected"
        ? { connectionScope: "localMedia" }
        : {}),
    });
    this.options.reportLifecycle?.({
      phase,
      componentAttemptId: String(this.common.attemptId),
      ...(reason === undefined ? {} : { reason }),
    });
  }

  private supplementary(): TelemetryEvent {
    return {
      ...this.common,
      schemaVersion: 1,
      eventSource: "component",
      sequence: ++this.sequence,
      elapsedMs: Math.max(0, Math.floor(this.now() - this.started)),
      hostAppVersion: this.options.hostAppVersion,
      hostAppBuild: this.options.hostAppBuild,
      correlationState:
        this.sessionId === undefined ? "unbound" : "provisional",
      ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
    };
  }

  private track(
    eventName: string,
    properties: Omit<TelemetryEvent, "eventName"> = {},
  ): void {
    this.options.track({ ...this.common, ...properties, eventName });
  }
}
