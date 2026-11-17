/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, describe, expect, it, vi } from "vitest";

import "./controls";
import { PosthogAnalytics } from "./analytics/PosthogAnalytics";
import {
  sentryErrorsEnabled,
  sentryPerformanceEnabled,
  setSentryReportingEnabled,
} from "./analytics/SentryReporting";
import { optInAnalytics } from "./settings/settings";
import { CallTelemetry } from "./analytics/CallTelemetry";

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

  it("keeps a crash-only attempt current through redundant false and later opt-in", () => {
    PosthogAnalytics.configure({
      matrixBackend: "embedded",
      hostUsageAnalyticsEnabled: false,
      apiKey: "fixture",
      apiHost: "https://analytics.example.org",
    });
    const analytics = PosthogAnalytics.instance;
    const isCurrent = analytics.callLifetime();
    const failure = vi.fn();
    const call = new CallTelemetry({
      callKind: "dm",
      componentVersion: "1",
      hostAppVersion: "1",
      hostAppBuild: "1",
      isCurrent,
      track: () => {},
      reportFailure: failure,
    });
    const values: (boolean | null)[] = [];
    const subscription = optInAnalytics.value$.subscribe((value) =>
      values.push(value),
    );
    window.controls.setUsageAnalyticsEnabled(false);
    window.controls.setUsageAnalyticsEnabled(false);
    expect(isCurrent()).toBe(true);
    expect(values).toEqual([false]);
    window.controls.setUsageAnalyticsEnabled(true);
    expect(isCurrent()).toBe(true);
    call.fail({
      cause: "joinTimedOut",
      stage: "homeserver",
      step: "membership",
    });
    expect(failure).toHaveBeenCalledTimes(1);
    subscription.unsubscribe();
  });

  it("keeps redundant true idempotent, while opt-out then opt-in leaves old attempts invalid", () => {
    optInAnalytics.setValue(true);
    const isCurrent = PosthogAnalytics.instance.callLifetime();
    const values: (boolean | null)[] = [];
    const subscription = optInAnalytics.value$.subscribe((value) =>
      values.push(value),
    );
    window.controls.setUsageAnalyticsEnabled(true);
    window.controls.setUsageAnalyticsEnabled(true);
    expect(isCurrent()).toBe(true);
    expect(values).toEqual([true]);
    window.controls.setUsageAnalyticsEnabled(false);
    expect(isCurrent()).toBe(false);
    window.controls.setUsageAnalyticsEnabled(true);
    expect(isCurrent()).toBe(false);
    expect(PosthogAnalytics.instance.callLifetime()()).toBe(true);
    subscription.unsubscribe();
  });

  it("preserves a live host choice made after content-loaded but before lazy analytics startup", () => {
    optInAnalytics.setValue(true);
    PosthogAnalytics.configure({
      matrixBackend: "embedded",
      hostUsageAnalyticsEnabled: false,
    });
    window.controls.setUsageAnalyticsEnabled(true);
    PosthogAnalytics.instance.callLifetime();
    expect(optInAnalytics.getValue()).toBe(true);
  });

  it.each([true, false])(
    "retains an idempotent early host override of %s before lazy startup",
    (enabled) => {
      optInAnalytics.setValue(enabled);
      const saved = localStorage.getItem("matrix-setting-opt-in-analytics");
      PosthogAnalytics.configure({
        matrixBackend: "embedded",
        hostUsageAnalyticsEnabled: !enabled,
      });
      window.controls.setUsageAnalyticsEnabled(enabled);
      PosthogAnalytics.instance.callLifetime();
      expect(optInAnalytics.getValue()).toBe(enabled);
      expect(localStorage.getItem("matrix-setting-opt-in-analytics")).toBe(
        saved,
      );
    },
  );

  it("requires literal true when host JavaScript supplies a malformed usage value", () => {
    window.controls.setUsageAnalyticsEnabled("false" as never);
    expect(optInAnalytics.getValue()).toBe(false);
  });
});
