/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

let errorsEnabled = false;
let performanceEnabled = false;
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

export function sentryPerformanceEnabled(): boolean {
  return performanceEnabled;
}
