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
  sentryPerformanceEnabled,
  rewriteEmbeddedCallFrame,
} from "./SentryReporting";

describe("native Sentry reporting choices", () => {
  it("maps installed iOS resources to the source-map upload prefix", () => {
    const frame = {
      filename: "file:///private/app/Call.bundle/dist/assets/index-abc.js",
      lineno: 42,
    };
    expect(rewriteEmbeddedCallFrame(frame)).toEqual({
      filename: "app:///element-call/assets/index-abc.js",
      lineno: 42,
    });
    const hosted = {
      filename: "https://call.example/assets/index-abc.js",
      lineno: 42,
    };
    expect(rewriteEmbeddedCallFrame(hosted)).toBe(hosted);
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
