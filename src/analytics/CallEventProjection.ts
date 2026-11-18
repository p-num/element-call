/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type CaptureResult, type Properties } from "posthog-js";

type Validator = (value: unknown) => boolean;
type Fields = Record<string, Validator>;

const oneOf =
  (...values: string[]): Validator =>
  (value) =>
    typeof value === "string" && values.includes(value);
const uuid = (value: unknown): boolean =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
const digest = (value: unknown): boolean =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const componentVersion = import.meta.env.VITE_APP_VERSION || "dev";
const wholeNumber =
  (minimum: number): Validator =>
  (value) =>
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum;

const endReasons = [
  "left",
  "othersLeft",
  "declined",
  "unanswered",
  "ringNotSent",
  "empty",
  "slotClosed",
  "connectionLost",
];
const coreFields: Fields = {
  callImplementation: oneOf("embedded"),
  callPlatform: oneOf("web"),
  callComponentVersion: (value) =>
    value === componentVersion &&
    /^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,63}$/.test(componentVersion),
  attemptId: uuid,
  callKind: oneOf("dm", "group"),
};
const supplementaryFields: Fields = {
  schemaVersion: (value) => value === 1,
  eventSource: oneOf("component"),
  sequence: wholeNumber(1),
  elapsedMs: wholeNumber(0),
  hostAppVersion: oneOf("unknown"),
  hostAppBuild: oneOf("unknown"),
  correlationState: oneOf("unbound", "provisional"),
};
const callEventFields = new Map<
  string,
  { required: Fields; optional?: Fields }
>([
  ["CallJoinAttempted", { required: {} }],
  [
    "CallJoinOutcome",
    {
      required: {
        outcome: oneOf("connected", "failed", "abandoned", "permissionRefused"),
      },
      optional: { endReason: oneOf(...endReasons) },
    },
  ],
  [
    "CallFailure",
    {
      required: {
        cause: oneOf(
          "joinTimedOut",
          "joinRefused",
          "slotClosed",
          "noMediaServer",
          "tokenEndpointUnsupported",
          "connectionLostNeverConnected",
          "connectionLostRefused",
          "connectionLostBudget",
          "microphoneFailed",
          "other",
        ),
        phase: oneOf("joining", "inCall"),
      },
      optional: {
        stage: oneOf("homeserver", "media"),
        step: oneOf(
          "transportDiscovery",
          "membership",
          "mediaToken",
          "mediaConnection",
          "unknown",
        ),
      },
    },
  ],
  [
    "CallParticipationEnded",
    {
      required: {
        endReason: oneOf(...endReasons),
        durationMs: wholeNumber(0),
        participantsMax: wholeNumber(1),
      },
    },
  ],
  [
    "CallLifecycle",
    {
      required: {
        ...supplementaryFields,
        phase: oneOf(
          "initiation",
          "ringing",
          "connected",
          "disconnected",
          "reconnected",
          "failed",
          "timedOut",
          "terminated",
        ),
      },
      optional: {
        reason: oneOf(
          ...endReasons,
          "failed",
          "permissionRefused",
          "abandoned",
          "replaced",
          "widgetSetupFailed",
          "joinTimedOut",
          "widgetLoadTimedOut",
          "webContentProcessTerminated",
          "componentEnded",
        ),
        connectionScope: oneOf("localMedia"),
        sessionId: digest,
      },
    },
  ],
  [
    "CallCorrelation",
    {
      required: {
        ...supplementaryFields,
        correlationKind: oneOf("binding", "edgeAndAlias"),
        canonicalRoot: digest,
      },
      optional: {
        sessionId: digest,
        participationId: digest,
        participantA: digest,
        participantB: digest,
        previousRoot: digest,
      },
    },
  ],
]);

export function projectCallEvent(
  event: CaptureResult,
  scoped = false,
): CaptureResult | null {
  const fields = callEventFields.get(event.event);
  if (!fields) return null;
  if (
    scoped &&
    (!uuid(event.uuid) ||
      !(event.timestamp instanceof Date) ||
      !Number.isFinite(event.timestamp.getTime()))
  )
    return null;

  const required = { ...coreFields, ...fields.required };
  const properties: Properties = {};
  for (const key of ["token", "distinct_id", "$process_person_profile"])
    if (Object.hasOwn(event.properties, key))
      properties[key] = event.properties[key];
  for (const [key, validate] of Object.entries(required)) {
    const value: unknown = event.properties[key];
    const present = Object.hasOwn(event.properties, key);
    if (scoped && (!present || !validate(value))) return null;
    if (present) properties[key] = value;
  }
  for (const [key, validate] of Object.entries(fields.optional ?? {})) {
    const value: unknown = event.properties[key];
    if (Object.hasOwn(event.properties, key) && (!scoped || validate(value)))
      properties[key] = value;
  }
  if (scoped && !hasRequiredContext(event.event, properties)) return null;

  return {
    event: event.event,
    uuid: event.uuid,
    timestamp: event.timestamp,
    properties,
  };
}

function hasRequiredContext(
  eventName: string,
  properties: Properties,
): boolean {
  if (eventName === "CallFailure" && properties.phase === "joining")
    return properties.stage !== undefined && properties.step !== undefined;
  if (eventName === "CallCorrelation")
    return properties.correlationKind === "binding"
      ? properties.participationId !== undefined
      : properties.participantA !== undefined &&
          properties.participantB !== undefined &&
          properties.previousRoot !== undefined;
  return true;
}
