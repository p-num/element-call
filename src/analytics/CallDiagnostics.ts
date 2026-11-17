/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  BrowserClient,
  defaultStackParser,
  makeFetchTransport,
  type Event,
} from "@sentry/react";

import { type TelemetryEvent } from "./CallTelemetry";

export interface CallDiagnosticsConfig {
  dsn?: string;
  release: string;
  environment?: string;
  consent(): boolean;
}

let report: (event: TelemetryEvent) => void = () => {};

/** A separate, integration-free client cannot inherit global users, logs or scopes. */
export function configureCallDiagnostics(config: CallDiagnosticsConfig): void {
  report = () => {};
  if (
    !import.meta.env.PROD ||
    import.meta.env.MODE === "development" ||
    !config.dsn
  )
    return;
  const client = new BrowserClient({
    dsn: config.dsn,
    release: config.release,
    environment: config.environment,
    integrations: [],
    stackParser: defaultStackParser,
    transport: makeFetchTransport,
    sendDefaultPii: false,
    beforeSend: (event) => {
      if (!config.consent()) return null;
      const safe = callFailureDiagnostic({
        ...event.contexts?.call,
        eventName: "CallFailure",
      });
      if (safe === null) return null;
      // The SDK can add ambient browser context even with no integrations.
      return {
        event_id: event.event_id,
        timestamp: event.timestamp,
        platform: "javascript",
        level: "warning",
        message: safe.message,
        exception: safe.exception,
        fingerprint: safe.fingerprint,
        tags: safe.tags,
        contexts: safe.contexts,
        release: config.release,
        environment: config.environment,
      };
    },
  });
  client.init();
  report = (event) => {
    if (!config.consent()) return;
    const diagnostic = callFailureDiagnostic(event);
    if (diagnostic !== null) client.captureEvent(diagnostic);
  };
}

export function reportCallFailure(event: TelemetryEvent): void {
  report(event);
}

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
    !["joining", "inCall"].includes(String(event.phase)) ||
    typeof event.attemptId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      event.attemptId,
    )
  )
    return null;
  const call: Record<string, string> = {
    attemptId: event.attemptId,
    cause: event.cause,
    phase: String(event.phase),
  };
  if (event.callKind === "dm" || event.callKind === "group")
    call.callKind = event.callKind;
  if (event.stage === "homeserver" || event.stage === "media")
    call.stage = event.stage;
  if (
    [
      "transportDiscovery",
      "membership",
      "mediaToken",
      "mediaConnection",
      "unknown",
    ].includes(String(event.step))
  )
    call.step = String(event.step);
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
