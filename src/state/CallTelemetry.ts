/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  EventType,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from "matrix-js-sdk";
import {
  CallMembership,
  type MatrixRTCSession,
  MatrixRTCSessionEvent,
} from "matrix-js-sdk/lib/matrixrtc";
import { combineLatest, fromEvent, merge, startWith } from "rxjs";
import {
  ErrorCode,
  type RTCParticipation,
  type ObservableScope,
  PeerConnectionTimeoutError,
  SFURoomCreationRestrictedError,
} from "@element-hq/matrixrtc-sdk";

import { CallTelemetry, type Failure } from "../analytics/CallTelemetry";
import {
  ParticipationGraph,
  participationDigest,
  normalizedSlot,
  type ParticipationIdentity,
} from "../analytics/ParticipationGraph";
import { reportCallFailure } from "../analytics/CallDiagnostics";
import { Anonymity, PosthogAnalytics } from "../analytics/PosthogAnalytics";
import { type HostBridge, nullHostBridge } from "../HostBridge";

/** Build this before slot.join(), so synchronous join failures have an attempt. */
export function createCallTelemetry(
  client: MatrixClient,
  room: Room,
  hostBridge: HostBridge,
  hostCallTelemetryEnabled = false,
): CallTelemetry {
  const direct =
    client
      .getAccountData(EventType.Direct)
      ?.getContent<Record<string, string[]>>() ?? {};
  const version = import.meta.env.VITE_APP_VERSION || "dev";
  const analytics = PosthogAnalytics.instance;
  const isCurrent = analytics.callLifetime();
  const hostOwnsLifecycle =
    hostCallTelemetryEnabled && hostBridge.notifyCallTelemetry !== undefined;
  return new CallTelemetry({
    callKind: Object.values(direct).some(
      (rooms) => Array.isArray(rooms) && rooms.includes(room.roomId),
    )
      ? "dm"
      : "group",
    componentVersion: version,
    hostAppVersion: hostBridge === nullHostBridge ? version : "unknown",
    hostAppBuild: hostBridge === nullHostBridge ? version : "unknown",
    isCurrent,
    lifecycleOwner: hostOwnsLifecycle ? "host" : "component",
    track: (event) => {
      if (isCurrent()) analytics.trackCallEvent(event);
    },
    reportLifecycle: hostOwnsLifecycle
      ? async (report) => await hostBridge.notifyCallTelemetry!(report)
      : undefined,
    reportFailure: (event) => {
      if (isCurrent()) reportCallFailure(event, isCurrent);
    },
  });
}

/** Observes existing multi-reader behaviors; it does not consume or drive RTC. */
export function observeCallTelemetry(
  scope: ObservableScope,
  telemetry: CallTelemetry,
  participation: RTCParticipation,
  session: MatrixRTCSession,
  room: Room,
): void {
  combineLatest([
    participation.state$,
    participation.initialMicrophonePublication$,
  ])
    .pipe(scope.bind())
    .subscribe(([state, microphone]) => {
      if (state.kind !== "left" && microphone.kind === "failed") {
        if (isPermissionRefused(microphone.error))
          telemetry.permissionRefused();
        else
          telemetry.fail({
            cause: "microphoneFailed",
            stage: "media",
            step: "mediaConnection",
          });
        return;
      }
      switch (state.kind) {
        case "connected":
          if (microphone.kind !== "pending") telemetry.connection(true);
          break;
        case "reconnecting":
          telemetry.connection(false);
          break;
        case "failed":
          if (isPermissionRefused(state.error)) telemetry.permissionRefused();
          else telemetry.fail(classifyCallFailure(state.error));
          break;
        case "left":
          telemetry.end();
          break;
      }
    });
  const graph = new ParticipationGraph();
  let active = true;
  const digests = new Map<string, Promise<string>>();
  combineLatest([
    merge(
      fromEvent(session, MatrixRTCSessionEvent.MembershipsChanged),
      telemetry.correlationReady$,
    ).pipe(startWith(null)),
    participation.localMember$,
  ])
    .pipe(scope.bind())
    .subscribe(([, local]) => {
      telemetry.participants(session.memberships.length);
      if (
        !telemetry.canCorrelate() ||
        local === null ||
        PosthogAnalytics.instance.getAnonymity() !== Anonymity.Pseudonymous
      )
        return;
      const identities = session.memberships.flatMap((membership) => {
        const identity = membershipIdentity(room, membership);
        return identity === undefined ? [] : [{ membership, identity }];
      });
      const isLocalDevice = (membership: CallMembership): boolean =>
        membership.userId === local.userId &&
        membership.deviceId === local.deviceId;
      const own = identities.find(
        ({ membership, identity }) =>
          isLocalDevice(membership) &&
          membership.memberId === local.memberId &&
          isCurrentLocalGeneration(session, identity.generation),
      );
      if (own === undefined) return;
      const digest = async (
        identity: ParticipationIdentity,
      ): Promise<string> => {
        const key = JSON.stringify(identity);
        let pending = digests.get(key);
        if (pending === undefined) {
          pending = participationDigest(identity);
          digests.set(key, pending);
        }
        return pending;
      };
      // An older membership for this device cannot also be a peer in this attempt.
      const peers = identities.filter(
        ({ membership }) => !isLocalDevice(membership),
      );
      void Promise.all(
        [own, ...peers].map(async ({ identity }) => digest(identity)),
      )
        .then((snapshot) => {
          if (
            !active ||
            !isCurrentLocalGeneration(session, own.identity.generation) ||
            PosthogAnalytics.instance.getAnonymity() !== Anonymity.Pseudonymous
          )
            return;
          for (const update of graph.observe(snapshot[0], snapshot))
            telemetry.correlation(update);
        })
        .catch(() => {});
    });
  scope.onEnd(() => {
    active = false;
    digests.clear();
    telemetry.end();
  });
}

function isCurrentLocalGeneration(
  session: MatrixRTCSession,
  generation: ParticipationIdentity["generation"],
): boolean {
  if (generation === "per-join") return true;
  // Older SDKs never mint an opaque ID for the current legacy join.
  if (!("localLegacyJoinId" in session))
    return generation.startsWith("legacy:");
  const joinId = session.localLegacyJoinId;
  return typeof joinId === "string" && generation === `legacy-join:${joinId}`;
}

/** createdTs() falls back to the refreshed event timestamp, which is not a join generation. */
export function membershipIdentity(
  room: Room,
  membership: CallMembership,
): ParticipationIdentity | undefined {
  const event = membershipSourceEvent(room, membership.eventId);
  if (event === undefined) return undefined;
  try {
    const parsed = CallMembership.membershipDataFromMatrixEvent(event);
    const generation =
      parsed.kind === "rtc" ? "per-join" : legacyGeneration(event);
    if (generation === undefined) return undefined;
    return {
      roomId: room.roomId,
      slotId: normalizedSlot(membership.slotId),
      sender: membership.userId,
      memberId: membership.memberId,
      generation,
    };
  } catch {
    return undefined;
  }
}

function legacyGeneration(
  event: MatrixEvent,
): ParticipationIdentity["generation"] | undefined {
  const joinIdField = "io.letro.call.join_id";
  const content = event.getContent<Record<string, unknown>>();
  if (Object.hasOwn(content, joinIdField)) {
    const joinId = content[joinIdField];
    if (
      typeof joinId === "string" &&
      joinId.length === 32 &&
      /^[0-9a-f]+$/.test(joinId)
    )
      return `legacy-join:${joinId}`;
    return undefined;
  }
  const timestamp = content.created_ts;
  if (
    Object.hasOwn(content, "created_ts") &&
    typeof timestamp === "number" &&
    Number.isSafeInteger(timestamp) &&
    timestamp >= 0
  )
    return `legacy:${BigInt(timestamp)}`;
  return undefined;
}

function membershipSourceEvent(
  room: Pick<
    Room,
    "findEventById" | "_unstable_getStickyEvents" | "currentState"
  >,
  eventId: string,
): MatrixEvent | undefined {
  const timelineEvent = room.findEventById(eventId);
  if (timelineEvent !== undefined) return timelineEvent;
  // Gappy sync can leave memberships only in the same active store MatrixRTCSession reads.
  for (const event of room._unstable_getStickyEvents()) {
    if (
      event.getType() === EventType.RTCMembership &&
      event.getId() === eventId
    )
      return event;
  }
  return room.currentState
    .getStateEvents(EventType.GroupCallMemberPrefix)
    .find((event) => event.getId() === eventId);
}

export function classifyCallFailure(error: { code: ErrorCode }): Failure {
  if (error instanceof PeerConnectionTimeoutError)
    return { cause: "joinTimedOut", stage: "media", step: "mediaConnection" };
  if (error instanceof SFURoomCreationRestrictedError)
    return { cause: "joinRefused", stage: "media", step: "mediaConnection" };
  switch (error.code) {
    case ErrorCode.MISSING_MATRIX_RTC_TRANSPORT:
      return {
        cause: "noMediaServer",
        stage: "homeserver",
        step: "transportDiscovery",
      };
    case ErrorCode.INTERNAL_MEMBERSHIP_MANAGER:
      return { cause: "other", stage: "homeserver", step: "membership" };
    case ErrorCode.NO_MATRIX_2_AUTHORIZATION_SERVICE:
      return {
        cause: "tokenEndpointUnsupported",
        stage: "media",
        step: "mediaToken",
      };
    case ErrorCode.OPEN_ID_ERROR:
      return { cause: "other", stage: "media", step: "mediaToken" };
    case ErrorCode.CONNECTION_LOST_ERROR:
      return {
        cause: "connectionLostBudget",
        stage: "media",
        step: "mediaConnection",
      };
    case ErrorCode.FAILED_TO_START_LIVEKIT:
      return {
        cause: "connectionLostNeverConnected",
        stage: "media",
        step: "mediaConnection",
      };
    default:
      return { cause: "other", stage: "media", step: "unknown" };
  }
}

function isPermissionRefused(error: Error): boolean {
  const cause = error.cause ?? error;
  return cause instanceof DOMException && cause.name === "NotAllowedError";
}
