/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";
import {
  configureSentryReporting,
  setSentryReportingEnabled,
  sentryErrorsEnabled,
  sentryErrorsGeneration,
  sentryPerformanceEnabled,
} from "./SentryReporting";

describe("native Sentry reporting choices", () => {
  it("advances the crash generation only when crash reporting is revoked", () => {
    setSentryReportingEnabled(true, false);
    const accepted = sentryErrorsGeneration();
    setSentryReportingEnabled(true, true);
    setSentryReportingEnabled(true, false);
    expect(sentryErrorsGeneration()).toBe(accepted);
    setSentryReportingEnabled(false, false);
    expect(sentryErrorsGeneration()).toBe(accepted + 1);
    setSentryReportingEnabled(false, true);
    expect(sentryErrorsGeneration()).toBe(accepted + 1);
    setSentryReportingEnabled(true, false);
    expect(sentryErrorsEnabled()).toBe(true);
    expect(sentryErrorsGeneration()).toBe(accepted + 1);
    setSentryReportingEnabled(false, false);
    expect(sentryErrorsGeneration()).toBe(accepted + 2);
  });

  it("starts lazily and revokes each collection channel during a call", () => {
    const start = vi.fn();
    configureSentryReporting(false, false, start);
    expect(start).not.toHaveBeenCalled();
    setSentryReportingEnabled(true, false);
    expect(start).toHaveBeenCalledTimes(1);
    expect(sentryErrorsEnabled()).toBe(true);
    expect(sentryPerformanceEnabled()).toBe(false);
    setSentryReportingEnabled(false, true);
    expect(sentryErrorsEnabled()).toBe(false);
    expect(sentryPerformanceEnabled()).toBe(true);
    setSentryReportingEnabled(false, false);
    expect(sentryErrorsEnabled()).toBe(false);
    expect(sentryPerformanceEnabled()).toBe(false);
    expect(start).toHaveBeenCalledTimes(1);
  });
});
