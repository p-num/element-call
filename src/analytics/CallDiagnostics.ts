/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  BrowserClient,
  defaultStackParser,
  makeFetchTransport,
  Scope,
  SDK_VERSION,
} from "@sentry/react";

import { CallDiagnosticTransport } from "./CallDiagnosticTransport";
import { type TelemetryEvent } from "./CallTelemetry";

export interface CallDiagnosticsConfig {
  dsn?: string;
  release: string;
  environment?: string;
  consent(): boolean;
  consentGeneration(): number;
}

export interface CallDiagnosticReporter {
  capture(event: TelemetryEvent, isCurrent: () => boolean): void;
  flush(): PromiseLike<boolean>;
}

let reporter: CallDiagnosticReporter | undefined;

export function configureCallDiagnostics(config: CallDiagnosticsConfig): void {
  reporter = createCallDiagnosticReporter(config);
}

/** Final-envelope validation is independent of SDK scope/processor/beforeSend ordering. */
export function createCallDiagnosticReporter(
  config: CallDiagnosticsConfig,
  transport: typeof makeFetchTransport = makeFetchTransport,
): CallDiagnosticReporter | undefined {
  if (
    !import.meta.env.PROD ||
    import.meta.env.MODE === "development" ||
    SDK_VERSION !== "8.55.2" ||
    !config.dsn
  )
    return undefined;
  const boundary = new CallDiagnosticTransport(config);
  const client = new BrowserClient({
    dsn: config.dsn,
    release: config.release,
    environment: config.environment,
    integrations: [],
    stackParser: defaultStackParser,
    transport: (options) => boundary.wrap(transport(options)),
    sendDefaultPii: false,
    sendClientReports: false,
  });
  client.init();
  return {
    capture: (source, isCurrent) => {
      const event = boundary.authorize(source, isCurrent);
      if (event !== undefined)
        client.captureEvent(event, { attachments: [] }, new Scope());
    },
    flush: async () => await client.flush(1000),
  };
}

export function reportCallFailure(
  event: TelemetryEvent,
  isCurrent: () => boolean,
): void {
  reporter?.capture(event, isCurrent);
}
