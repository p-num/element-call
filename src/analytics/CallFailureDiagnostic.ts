/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type Event } from "@sentry/react";

/** The input is never spread: server errors, errcodes and IDs have no route here. */
export function callFailureDiagnostic(
  event: Record<string, unknown>,
): Event | null {
  const causes = [
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
  ];
  if (
    event.eventName !== "CallFailure" ||
    typeof event.cause !== "string" ||
    !causes.includes(event.cause) ||
    (event.phase !== "joining" && event.phase !== "inCall") ||
    (event.callKind !== "dm" && event.callKind !== "group") ||
    typeof event.attemptId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      event.attemptId,
    )
  )
    return null;
  const steps = [
    "transportDiscovery",
    "membership",
    "mediaToken",
    "mediaConnection",
    "unknown",
  ];
  if (
    event.phase === "joining" &&
    ((event.stage !== "homeserver" && event.stage !== "media") ||
      typeof event.step !== "string" ||
      !steps.includes(event.step))
  )
    return null;
  const call: Record<string, string> = {
    attemptId: event.attemptId,
    cause: event.cause,
    phase: event.phase,
    callKind: event.callKind,
  };
  if (event.phase === "joining") {
    call.stage = String(event.stage);
    call.step = String(event.step);
  }
  return {
    message: "Unsuccessful call",
    exception: {
      values: [
        {
          type: "CallFailure",
          value: event.cause,
          mechanism: { type: "generic", handled: true },
        },
      ],
    },
    level: "warning",
    fingerprint: ["call-failure", event.cause, String(event.phase)],
    tags: {
      category: "call-failure",
      cause: event.cause,
      phase: String(event.phase),
      callPlatform: "web",
      callImplementation: "embedded",
    },
    contexts: { call },
  };
}
