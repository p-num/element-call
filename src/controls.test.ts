/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, describe, expect, it, vi } from "vitest";

import { deferHostReportingUntilReady } from "./controls";
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

  it("applies the latest choices before releasing the call on the host's acknowledgement", async () => {
    optInAnalytics.setRuntimeValue(false, "host-initial");
    const acknowledgement = Promise.withResolvers<void>();
    const releaseCall = deferHostReportingUntilReady();
    const reporting = () => [
      optInAnalytics.getValue(),
      sentryErrorsEnabled(),
      sentryPerformanceEnabled(),
    ];
    const callReady = vi.fn(reporting);
    const ready = releaseCall(acknowledgement.promise).then(callReady);

    window.controls.setUsageAnalyticsEnabled(true);
    window.controls.setSentryReportingEnabled(true, true);
    window.controls.setSentryReportingEnabled(false, true);
    await Promise.resolve();
    expect(callReady).not.toHaveBeenCalled();
    expect(optInAnalytics.getValue()).toBe(false);
    expect(sentryErrorsEnabled()).toBe(false);
    expect(sentryPerformanceEnabled()).toBe(false);

    acknowledgement.resolve();
    await expect(ready).resolves.toEqual([true, false, true]);
    expect(callReady).toHaveBeenCalledOnce();

    window.controls.setUsageAnalyticsEnabled(false);
    window.controls.setSentryReportingEnabled(true, false);
    expect(reporting()).toEqual([false, true, false]);
  });

  it.each(["timeout", "rejection"])(
    "releases the call with reporting disabled for the document after %s",
    async (failure) => {
      const previousControls = window.controls;
      vi.resetModules();
      try {
        const { deferHostReportingUntilReady: deferReporting } =
          await import("./controls");
        const sentry = await import("./analytics/SentryReporting");
        const { optInAnalytics: usage } = await import("./settings/settings");
        usage.setRuntimeValue(false, "host-initial");
        vi.useFakeTimers();
        const acknowledgement = Promise.withResolvers<void>();
        const releaseCall = deferReporting();
        const reporting = () => [
          usage.getValue(),
          sentry.sentryErrorsEnabled(),
          sentry.sentryPerformanceEnabled(),
        ];
        const callReady = vi.fn(reporting);
        const ready = releaseCall(acknowledgement.promise).finally(callReady);
        window.controls.setUsageAnalyticsEnabled(true);
        window.controls.setSentryReportingEnabled(true, true);

        if (failure === "timeout") {
          await vi.advanceTimersByTimeAsync(2_000);
          await ready;
          acknowledgement.resolve();
          await Promise.resolve();
        } else {
          acknowledgement.reject(new Error("Widget reply failed"));
          await expect(ready).rejects.toThrow("Widget reply failed");
        }

        expect(callReady).toHaveBeenCalledOnce();
        expect(callReady).toHaveReturnedWith([false, false, false]);
        window.controls.setUsageAnalyticsEnabled(true);
        window.controls.setSentryReportingEnabled(true, true);
        expect(reporting()).toEqual([false, false, false]);
      } finally {
        window.controls = previousControls;
        vi.useRealTimers();
      }
    },
  );

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
