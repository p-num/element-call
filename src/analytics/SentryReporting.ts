/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type StackFrame } from "@sentry/react";

let errorsEnabled = false;
let errorsGeneration = 0;
let performanceEnabled = false;
let performanceGeneration = 0;
let initialize: (() => void) | undefined;

export function configureSentryReporting(
  errors: boolean,
  performance: boolean,
  start: () => void,
): void {
  initialize = start;
  setSentryReportingEnabled(errors, performance);
}

export function setSentryReportingEnabled(
  errors: boolean,
  performance: boolean,
): void {
  if (errorsEnabled && !errors) errorsGeneration++;
  if (performanceEnabled && !performance) performanceGeneration++;
  errorsEnabled = errors;
  performanceEnabled = performance;
  if ((errors || performance) && initialize) {
    const start = initialize;
    initialize = undefined;
    start();
  }
}

export function sentryErrorsEnabled(): boolean {
  return errorsEnabled;
}

export function sentryErrorsGeneration(): number {
  return errorsGeneration;
}

export function sentryPerformanceEnabled(): boolean {
  return performanceEnabled;
}

export function sentryPerformanceGeneration(): number {
  return performanceGeneration;
}

export function embeddedSentryEnvironment(environment?: string | null): string {
  return environment && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(environment)
    ? environment
    : "production";
}

export function rewriteEmbeddedCallFrame(frame: StackFrame): StackFrame {
  const asset = frame.filename?.match(
    /^file:\/\/.*\/dist\/assets\/([^/?#]+\.js)(?:[?#].*)?$/,
  )?.[1];
  return asset
    ? { ...frame, filename: `app:///element-call/assets/${asset}` }
    : frame;
}
