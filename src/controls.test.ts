/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, describe, expect, it } from "vitest";

import "./controls";
import { PosthogAnalytics } from "./analytics/PosthogAnalytics";
import {
  sentryErrorsEnabled,
  sentryPerformanceEnabled,
  setSentryReportingEnabled,
} from "./analytics/SentryReporting";
import { optInAnalytics } from "./settings/settings";

describe("native host reporting controls", () => {
  afterEach(() => {
    PosthogAnalytics.resetInstance();
    setSentryReportingEnabled(false, false);
  });

  it("revokes accepted-attempt lifetimes synchronously without overwriting saved standalone consent", () => {
    optInAnalytics.setValue(true);
    const saved = localStorage.getItem("matrix-setting-opt-in-analytics");
    const isCurrent = PosthogAnalytics.instance.callLifetime();
    window.controls.setUsageAnalyticsEnabled(false);
    expect(optInAnalytics.getValue()).toBe(false);
    expect(isCurrent()).toBe(false);
    window.controls.setUsageAnalyticsEnabled(true);
    expect(isCurrent()).toBe(false);
    expect(PosthogAnalytics.instance.callLifetime()()).toBe(true);
    expect(localStorage.getItem("matrix-setting-opt-in-analytics")).toBe(saved);
  });

  it("keeps live usage, error and performance choices independent", () => {
    window.controls.setSentryReportingEnabled(false, true);
    window.controls.setUsageAnalyticsEnabled(true);
    expect(sentryErrorsEnabled()).toBe(false);
    expect(sentryPerformanceEnabled()).toBe(true);
    window.controls.setSentryReportingEnabled(true, false);
    window.controls.setUsageAnalyticsEnabled(false);
    expect(optInAnalytics.getValue()).toBe(false);
    expect(sentryErrorsEnabled()).toBe(true);
    expect(sentryPerformanceEnabled()).toBe(false);
  });

  it("preserves a live host choice made after content-loaded but before lazy analytics startup", () => {
    PosthogAnalytics.configure({
      matrixBackend: "embedded",
      hostUsageAnalyticsEnabled: false,
    });
    window.controls.setUsageAnalyticsEnabled(true);
    PosthogAnalytics.instance.callLifetime();
    expect(optInAnalytics.getValue()).toBe(true);
  });

  it("requires literal true when host JavaScript supplies a malformed usage value", () => {
    window.controls.setUsageAnalyticsEnabled("false" as never);
    expect(optInAnalytics.getValue()).toBe(false);
  });
});
