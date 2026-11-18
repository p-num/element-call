/*
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  expect,
  describe,
  it,
  vi,
  beforeEach,
  beforeAll,
  afterAll,
} from "vitest";
import posthog, { type CaptureResult, PostHog } from "posthog-js";
import { type MatrixClient } from "matrix-js-sdk";

import {
  Anonymity,
  santizeSensitiveData,
  PosthogAnalytics,
} from "./PosthogAnalytics";
import { mockConfig } from "../utils/test";
import { analyticsConfigFromEnvironment } from "../initializer";
import { optInAnalytics } from "../settings/settings";
import { CallTelemetry } from "./CallTelemetry";

const browserFetch = vi.hoisted(() =>
  vi.fn<typeof fetch>(async () => Promise.resolve(new Response("{}"))),
);

// The browser bundle binds Fetch at import. The global test setup loads the separate Node entry.
vi.mock("posthog-js", async () => {
  vi.stubGlobal("fetch", browserFetch);
  try {
    return await import("posthog-js/dist/module.js");
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("PosthogAnalytics", () => {
  describe("enablement", () => {
    beforeEach(() => {
      PosthogAnalytics.resetInstance();
    });

    it("stays off until it is configured", () => {
      expect(PosthogAnalytics.instance.isEnabled()).toBe(false);
    });

    it("stays off when configured without credentials", () => {
      PosthogAnalytics.configure({ matrixBackend: "jssdk" });
      expect(PosthogAnalytics.instance.isEnabled()).toBe(false);
    });

    it("stays off when given only a key", () => {
      PosthogAnalytics.configure({
        matrixBackend: "jssdk",
        apiKey: "api_key",
      });
      expect(PosthogAnalytics.instance.isEnabled()).toBe(false);
    });

    it("turns on when given both a key and a host", () => {
      PosthogAnalytics.configure({
        matrixBackend: "jssdk",
        apiKey: "api_key",
        apiHost: "https://api.example.com.localhost",
      });
      expect(PosthogAnalytics.instance.isEnabled()).toBe(true);
    });
  });

  // Which of the URL and config.json the credentials come from is a deliberate
  // policy: an embedder is responsible for its own users' telemetry, so it must
  // not pick up the deployment's, and vice versa.
  describe("analyticsConfigFromEnvironment", () => {
    beforeEach(() => {
      mockConfig({});
      window.location.hash = "#";
    });

    afterAll(() => {
      vi.unstubAllEnvs();
    });

    const urlCredentials = `posthogApiHost=${encodeURIComponent("https://url.example.com.localhost")}&posthogApiKey=url_key`;
    const configCredentials = {
      posthog: {
        api_host: "https://config.example.com.localhost",
        api_key: "config_key",
      },
    };

    describe("embedded package", () => {
      beforeAll(() => {
        vi.stubEnv("VITE_PACKAGE", "embedded");
      });

      it("has no credentials without URL params", () => {
        expect(analyticsConfigFromEnvironment().apiKey).toBeUndefined();
      });

      it("takes the credentials from the URL", () => {
        window.location.hash = `#?${urlCredentials}`;
        expect(analyticsConfigFromEnvironment()).toMatchObject({
          apiKey: "url_key",
          apiHost: "https://url.example.com.localhost",
        });
      });

      it("ignores the deployment's config", () => {
        mockConfig(configCredentials);
        expect(analyticsConfigFromEnvironment().apiKey).toBeUndefined();
      });

      it.each([undefined, "true", "false", "TRUE"])(
        "uses the native host's exact usage choice (%s)",
        (choice) => {
          window.location.hash =
            `#?widgetId=fixture&parentUrl=https://host.example.com&hostCallTelemetryEnabled=true` +
            (choice === undefined ? "" : `&usageAnalyticsEnabled=${choice}`);
          expect(analyticsConfigFromEnvironment()).toMatchObject({
            widgetScopedAnalyticsId: true,
            hostUsageAnalyticsEnabled: choice === "true",
          });
        },
      );
    });

    describe("full package", () => {
      beforeAll(() => {
        vi.stubEnv("VITE_PACKAGE", "full");
      });

      it("has no credentials without config", () => {
        expect(analyticsConfigFromEnvironment().apiKey).toBeUndefined();
      });

      it("takes the credentials from the config", () => {
        mockConfig(configCredentials);
        expect(analyticsConfigFromEnvironment()).toMatchObject({
          apiKey: "config_key",
          apiHost: "https://config.example.com.localhost",
        });
      });

      it("ignores the URL params", () => {
        window.location.hash = `#?${urlCredentials}`;
        expect(analyticsConfigFromEnvironment().apiKey).toBeUndefined();
      });
    });

    // Who owns the user's analytics identity depends on how Element Call is
    // running, not on which package it was built as.
    it("reports the embedded backend when running as a widget", () => {
      vi.stubEnv("VITE_PACKAGE", "full");
      window.location.hash = `#?widgetId=id&parentUrl=${encodeURIComponent("https://host.example.com.localhost")}&posthogUserId=given_id`;
      expect(analyticsConfigFromEnvironment()).toMatchObject({
        matrixBackend: "embedded",
        hostAnalyticsId: "given_id",
      });
    });

    it("reports the jssdk backend when running standalone", () => {
      expect(analyticsConfigFromEnvironment().matrixBackend).toBe("jssdk");
    });

    it.each(["widgetId=fixture&parentUrl=https://host.example.com&", ""])(
      "keeps the full package usage choice independent of embedded URL flags (%s)",
      (widgetParams) => {
        vi.stubEnv("VITE_PACKAGE", "full");
        window.location.hash = `#?${widgetParams}usageAnalyticsEnabled=true`;
        expect(
          analyticsConfigFromEnvironment().hostUsageAnalyticsEnabled,
        ).toBeUndefined();
      },
    );
  });

  describe("applyPrivacyFilters", () => {
    it("strips every ambient property and all room IDs from call telemetry", () => {
      const event = {
        event: "CallLifecycle",
        properties: {
          distinct_id: "consented-analytics-id",
          schemaVersion: 1,
          phase: "connected",
          callId: "!secret:server",
          $current_url: "https://call.example/secret",
          $device_id: "secret",
          $referrer: "secret",
          $set: { token: "secret" },
          token: "project-key",
        },
        $set: { token: "secret" },
        $set_once: { token: "secret" },
      } as unknown as CaptureResult;
      const safe = santizeSensitiveData(event, Anonymity.Pseudonymous);
      expect(safe?.properties).toEqual({
        distinct_id: "consented-analytics-id",
        schemaVersion: 1,
        phase: "connected",
        token: "project-key",
      });
      expect(JSON.stringify(safe)).not.toContain("secret");
    });
    const makeEvent = (properties: Record<string, unknown>): CaptureResult =>
      ({ event: "anyEvent", properties }) as unknown as CaptureResult;

    it("drops $initial_person_info regardless of anonymity", () => {
      const out = santizeSensitiveData(
        makeEvent({
          $current_url: "https://call.example.com/some/private/path",
          $initial_person_info: {
            r: "https://example.com/referrer",
            u: "https://call.example.com/some/private/path",
          },
        }),
        Anonymity.Pseudonymous,
      );
      expect(out?.properties).not.toHaveProperty("$initial_person_info");
    });

    it("strips hash from $current_url", () => {
      const out = santizeSensitiveData(
        makeEvent({ $current_url: "https://call.example.com/#/x/y/z" }),
        Anonymity.Pseudonymous,
      );
      expect(out?.properties["$current_url"]).not.toContain("/x/y/z");
    });

    it("nulls referrer and device fields when anonymous", () => {
      const out = santizeSensitiveData(
        makeEvent({
          $current_url: "https://x/y",
          $referrer: "https://leaky",
          $initial_referrer: "https://leaky-too",
          $device_id: "uuid",
        }),
        Anonymity.Anonymous,
      );
      expect(out?.properties["$referrer"]).toBeUndefined();
      expect(out?.properties["$initial_referrer"]).toBeUndefined();
      expect(out?.properties["$device_id"]).toBeUndefined();
    });

    it("passes null events through unchanged", () => {
      expect(santizeSensitiveData(null, Anonymity.Pseudonymous)).toBeNull();
    });

    it("strips URL fields nested inside $set_once", () => {
      const secretUrl =
        "https://call.example.com/room/#/?password=hunter2&roomId=abc";
      const out = santizeSensitiveData(
        makeEvent({
          $current_url: "https://call.example.com/x",
          $set_once: {
            $current_url: secretUrl,
            $initial_current_url: secretUrl,
            $session_entry_url: secretUrl,
            $initial_person_info: { r: "x", u: secretUrl },
          },
        }),
        Anonymity.Pseudonymous,
      );

      const setOnce = out?.properties["$set_once"] as Record<string, unknown>;
      expect(setOnce["$current_url"]).not.toContain("password");
      expect(setOnce["$initial_current_url"]).not.toContain("password");
      expect(setOnce).not.toHaveProperty("$session_entry_url");
      expect(setOnce).not.toHaveProperty("$initial_person_info");
    });

    it("strips URL fields nested inside $set", () => {
      const secretUrl =
        "https://call.example.com/room/#/?password=hunter2&roomId=abc";
      const out = santizeSensitiveData(
        makeEvent({
          $current_url: "https://call.example.com/x",
          $set: {
            $current_url: secretUrl,
            $session_entry_url: secretUrl,
          },
        }),
        Anonymity.Pseudonymous,
      );

      const set = out?.properties["$set"] as Record<string, unknown>;
      expect(set["$current_url"]).not.toContain("password");
      expect(set).not.toHaveProperty("$session_entry_url");
    });

    it("nulls referrer fields inside $set_once when anonymous", () => {
      const out = santizeSensitiveData(
        makeEvent({
          $current_url: "https://x/y",
          $set_once: {
            $initial_referrer: "https://leaky",
            $initial_referring_domain: "leaky",
          },
        }),
        Anonymity.Anonymous,
      );

      const setOnce = out?.properties["$set_once"] as Record<string, unknown>;
      expect(setOnce["$initial_referrer"]).toBeUndefined();
      expect(setOnce["$initial_referring_domain"]).toBeUndefined();
    });
  });

  // Verifies that applyPrivacyFilters is actually wired into posthog.init via
  // the before_send hook — guards against typos in the option name or future
  // posthog-js bumps renaming/removing the hook. The filter logic itself is
  // covered by the applyPrivacyFilters block above.
  describe("posthog.init wiring", () => {
    beforeEach(() => {
      PosthogAnalytics.resetInstance();
      PosthogAnalytics.configure({
        matrixBackend: "jssdk",
        apiKey: "api_key",
        apiHost: "https://api.example.com.localhost",
      });
    });

    it("passes events through the privacy filter via before_send", () => {
      const initSpy = vi.spyOn(posthog, "init");
      expect(PosthogAnalytics.instance.isEnabled()).toBe(true);

      const beforeSend = initSpy.mock.calls[0][1]?.before_send;
      expect(beforeSend).toBeInstanceOf(Function);

      const event = {
        event: "anyEvent",
        properties: {
          $current_url: "https://call.example.com/x/y",
          $initial_person_info: { r: "x" },
        },
      } as unknown as CaptureResult;

      const out = (beforeSend as (e: CaptureResult) => CaptureResult | null)(
        event,
      );
      expect(out?.properties).not.toHaveProperty("$initial_person_info");
    });
  });
});

describe("identifying the user", () => {
  const credentials = {
    apiKey: "api_key",
    apiHost: "https://api.example.com.localhost",
  };
  const widgetId = "b6bd305a-4af0-4101-8c81-a04fac79f04f";
  const replacementWidgetId = "c65d3aa3-e5f8-48f7-b9bc-617538453143";
  const scopedCore = {
    callImplementation: "embedded",
    callPlatform: "web",
    callComponentVersion: import.meta.env.VITE_APP_VERSION || "dev",
    attemptId: "168cd40b-2376-4e14-887d-3008e7ee58d4",
    callKind: "dm",
  };
  const scopedSupplementary = {
    schemaVersion: 1,
    eventSource: "component",
    sequence: 3,
    elapsedMs: 120,
    hostAppVersion: "unknown",
    hostAppBuild: "unknown",
    correlationState: "unbound",
  };

  function mockClient(accountDataId: string | null): MatrixClient {
    return {
      isGuest: () => false,
      getCrypto: () => undefined,
      getAccountDataFromServer: vi
        .fn()
        .mockResolvedValue(
          accountDataId === null ? null : { id: accountDataId },
        ),
      setAccountData: vi.fn().mockResolvedValue({}),
    } as Partial<MatrixClient> as MatrixClient;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(posthog, "identify").mockImplementation(() => {});
    PosthogAnalytics.resetInstance();
    optInAnalytics.setValue(true);
  });

  it("keeps the saved usage choice and the host identity in a full-package widget", async () => {
    const client = mockClient(null);
    window.matrixclient = client;
    PosthogAnalytics.configure({
      ...credentials,
      matrixBackend: "embedded",
      hostAnalyticsId: "assigned-by-host",
    });
    const identify = vi.spyOn(posthog, "identify");

    PosthogAnalytics.instance.startListeningToSettingsChanges();
    await vi.waitFor(() =>
      expect(identify).toHaveBeenCalledWith("assigned-by-host"),
    );
    expect(optInAnalytics.getValue()).toBe(true);

    // The host owns the user's account, so Element Call must not write to it
    expect(client.setAccountData).not.toHaveBeenCalled();
  });

  it("sends scoped requests and their retries through fetch without a referrer", async () => {
    vi.useFakeTimers();
    browserFetch.mockClear();
    browserFetch.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    try {
      startScopedWidget(widgetId).trackCallEvent({
        eventName: "CallJoinAttempted",
        ...scopedCore,
      });
      expect(browserFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(6_001);
      expect(browserFetch).toHaveBeenCalledTimes(2);
      for (const [url, options] of browserFetch.mock.calls) {
        expect(url).toEqual(expect.stringContaining(`${credentials.apiHost}/`));
        expect(options).toMatchObject({
          method: "POST",
          referrerPolicy: "no-referrer",
          body: expect.any(String),
        });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops scoped requests when fetch is unavailable", () => {
    browserFetch.mockClear();
    const send = vi.spyOn(XMLHttpRequest.prototype, "send");
    vi.stubGlobal("fetch", undefined);
    try {
      startScopedWidget(widgetId).trackCallEvent({
        eventName: "CallJoinAttempted",
        ...scopedCore,
      });
      expect(browserFetch).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("delivers typed mobile boundaries with the ingest envelope and retires the widget identity on opt-out", () => {
    const { init, send } = observePosthogRequests();
    const register = vi.spyOn(PostHog.prototype, "register");
    const identify = vi.spyOn(PostHog.prototype, "identify");
    const reset = vi.spyOn(PostHog.prototype, "reset");
    const analytics = startScopedWidget(widgetId);
    const sdk = init.mock.results[0].value as PostHog;
    expect(sdk.config).toMatchObject({
      persistence: "memory",
      person_profiles: "never",
      request_batching: false,
    });
    analytics.trackCallEvent({ eventName: "CallJoinAttempted", ...scopedCore });
    analytics.trackCallEvent({
      eventName: "CallCorrelation",
      ...scopedCore,
      ...scopedSupplementary,
      correlationKind: "binding",
      participationId: "a".repeat(64),
      canonicalRoot: "b".repeat(64),
    });
    expect(register).toHaveBeenCalledWith({ distinct_id: widgetId });
    expect(identify).not.toHaveBeenCalled();
    const ingestProperties = {
      token: credentials.apiKey,
      distinct_id: widgetId,
      $process_person_profile: false,
      ...scopedCore,
    };
    expect(send.mock.calls.map(([body]) => JSON.parse(String(body)))).toEqual([
      {
        api_key: credentials.apiKey,
        sent_at: expect.any(String),
        batch: [
          {
            event: "CallJoinAttempted",
            uuid: expect.any(String),
            timestamp: expect.any(String),
            properties: ingestProperties,
          },
        ],
      },
      {
        api_key: credentials.apiKey,
        sent_at: expect.any(String),
        batch: [
          {
            event: "CallCorrelation",
            uuid: expect.any(String),
            timestamp: expect.any(String),
            properties: {
              ...ingestProperties,
              ...scopedSupplementary,
              correlationKind: "binding",
              participationId: "a".repeat(64),
              canonicalRoot: "b".repeat(64),
            },
          },
        ],
      },
    ]);

    const calculateProperties = sdk.calculateEventProperties.bind(sdk);
    const properties = vi.spyOn(sdk, "calculateEventProperties");
    for (const invalidEnvelope of [
      { token: "unexpected-project-key" },
      { $process_person_profile: true },
      { $process_person_profile: undefined },
    ]) {
      properties.mockImplementationOnce((...args) => ({
        ...calculateProperties(...args),
        ...invalidEnvelope,
      }));
      analytics.trackCallEvent({
        eventName: "CallJoinAttempted",
        ...scopedCore,
      });
    }
    expect(send).toHaveBeenCalledTimes(2);

    PosthogAnalytics.setUsageAnalyticsEnabled(false);
    analytics.trackCallEvent({ eventName: "CallJoinAttempted", ...scopedCore });
    PosthogAnalytics.setUsageAnalyticsEnabled(true);
    analytics.callLifetime();
    analytics.trackCallEvent({ eventName: "CallJoinAttempted", ...scopedCore });
    expect(reset).toHaveBeenCalled();
    sdk.capture("CallJoinAttempted", { ...scopedCore, distinct_id: widgetId });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("projects only issue #411 events onto the mobile widget wire payload", async () => {
    const { init, send } = observePosthogRequests();
    const analytics = startScopedWidget(widgetId);
    const sdk = init.mock.results[0].value as PostHog;
    const privateUrl =
      "https://call.example/private-room?token=widget-url-secret#widgetId=private-widget-id";
    sdk.register({
      $current_url: privateUrl,
      $pathname: "/private-room",
      $session_entry_pathname: "/private-room",
      $session_entry_utm_source: "private-widget-id",
      arbitrarySuperProperty: privateUrl,
    });
    analytics.eventCallStarted.track("!private-room:example.com");
    analytics.eventQualitySurvey.track(
      "!private-room:example.com",
      "private feedback text",
      4,
    );
    sdk.capture("UnexpectedEvent", { widgetId: "private-widget-id" });
    sdk.capture("CallJoinAttempted", { ...scopedCore, attemptId: privateUrl });
    sdk.capture("CallJoinOutcome", { ...scopedCore, outcome: privateUrl });
    sdk.capture("CallLifecycle", {
      ...scopedCore,
      ...scopedSupplementary,
      phase: "connected",
      hostAppVersion: privateUrl,
    });
    sdk.capture(
      "CallLifecycle",
      {
        ...scopedCore,
        ...scopedSupplementary,
        phase: "connected",
        connectionScope: "localMedia",
        reason: privateUrl,
        widgetId: "private-widget-id",
        cause: privateUrl,
      },
      {
        $set: { url: privateUrl },
        $set_once: { url: privateUrl },
        $unset: [privateUrl],
      },
    );

    await Promise.resolve();
    expect(send).toHaveBeenCalledOnce();
    expect(JSON.parse(String(send.mock.calls[0][0]))).toEqual({
      api_key: credentials.apiKey,
      sent_at: expect.any(String),
      batch: [
        {
          event: "CallLifecycle",
          uuid: expect.any(String),
          timestamp: expect.any(String),
          properties: {
            token: credentials.apiKey,
            distinct_id: widgetId,
            $process_person_profile: false,
            ...scopedCore,
            ...scopedSupplementary,
            phase: "connected",
            connectionScope: "localMedia",
          },
        },
      ],
    });
  });

  it.each(["unchanged", "opt-out", "replacement"] as const)(
    "retries a failed request only while its widget identity is current (%s)",
    async (transition) => {
      vi.useFakeTimers();
      try {
        let status = 500;
        const { send } = observePosthogRequests(() => status);
        startScopedWidget(widgetId).trackCallEvent({
          eventName: "CallJoinAttempted",
          ...scopedCore,
        });
        expect(send).toHaveBeenCalledTimes(1);

        status = 200;
        if (transition === "opt-out") {
          PosthogAnalytics.setUsageAnalyticsEnabled(false);
        } else if (transition === "replacement") {
          PosthogAnalytics.resetInstance();
          startScopedWidget(replacementWidgetId).trackCallEvent({
            eventName: "CallJoinAttempted",
            ...scopedCore,
          });
        }

        await vi.advanceTimersByTimeAsync(6_001);
        const expectedIds = {
          unchanged: [widgetId, widgetId],
          "opt-out": [widgetId],
          replacement: [widgetId, replacementWidgetId],
        };
        expect(
          send.mock.calls.map(
            ([body]) =>
              JSON.parse(String(body)).batch[0].properties.distinct_id,
          ),
        ).toEqual(expectedIds[transition]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([undefined, "@raw:example.org"])(
    "cannot report from a mobile widget with an absent or invalid identity (%s)",
    (hostAnalyticsId) => {
      window.matrixclient = mockClient(null);
      PosthogAnalytics.configure({
        ...credentials,
        matrixBackend: "embedded",
        hostAnalyticsId,
        hostUsageAnalyticsEnabled: true,
        widgetScopedAnalyticsId: true,
      });
      const capture = vi.spyOn(PostHog.prototype, "capture");
      const analytics = PosthogAnalytics.instance;
      analytics.callLifetime();
      analytics.trackCallEvent({ eventName: "CallJoinAttempted" });
      expect(capture).not.toHaveBeenCalled();
    },
  );

  it("captures final call events synchronously and drops them immediately on logout", () => {
    window.matrixclient = mockClient(null);
    PosthogAnalytics.configure({
      ...credentials,
      matrixBackend: "embedded",
      hostAnalyticsId: "host-id",
      hostUsageAnalyticsEnabled: true,
    });
    const capture = vi.spyOn(posthog, "capture");
    const analytics = PosthogAnalytics.instance;
    analytics.startListeningToSettingsChanges();
    analytics.trackCallEvent({
      eventName: "CallLifecycle",
      phase: "terminated",
    });
    expect(capture).toHaveBeenCalledTimes(1);
    analytics.logout();
    analytics.trackCallEvent({
      eventName: "CallLifecycle",
      phase: "terminated",
    });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("queues first-use call boundaries until the account identity is accepted, then captures teardown synchronously", async () => {
    const accountData = Promise.withResolvers<{ id: string }>();
    const client = mockClient(null);
    vi.mocked(client.getAccountDataFromServer).mockReturnValue(
      accountData.promise,
    );
    window.matrixclient = client;
    PosthogAnalytics.configure({ ...credentials, matrixBackend: "jssdk" });
    let distinctId = "transient-before-identification";
    vi.spyOn(posthog, "identify").mockImplementation((id) => {
      distinctId = id!;
    });
    const delivered: { event: string; identity: string }[] = [];
    vi.spyOn(posthog, "capture").mockImplementation((event) => {
      delivered.push({ event, identity: distinctId });
      return undefined;
    });
    const analytics = PosthogAnalytics.instance;
    analytics.callLifetime();
    analytics.trackCallEvent({ eventName: "CallJoinAttempted" });
    analytics.trackCallEvent({
      eventName: "CallJoinOutcome",
      outcome: "connected",
    });
    expect(delivered).toEqual([]);
    accountData.resolve({ id: "accepted-account-identity" });
    await vi.waitFor(() => expect(delivered).toHaveLength(2));
    analytics.trackCallEvent({ eventName: "CallParticipationEnded" });
    analytics.logout();
    expect(delivered).toEqual([
      { event: "CallJoinAttempted", identity: "accepted-account-identity" },
      { event: "CallJoinOutcome", identity: "accepted-account-identity" },
      {
        event: "CallParticipationEnded",
        identity: "accepted-account-identity",
      },
    ]);
  });

  it.each(["logout", "reset", "optOutThenIn"])(
    "drops queued call boundaries from a revoked generation after %s",
    async (action) => {
      const accountData = Promise.withResolvers<{ id: string }>();
      const client = mockClient(null);
      vi.mocked(client.getAccountDataFromServer).mockReturnValue(
        accountData.promise,
      );
      window.matrixclient = client;
      PosthogAnalytics.configure({ ...credentials, matrixBackend: "jssdk" });
      const capture = vi.spyOn(posthog, "capture");
      const identify = vi.spyOn(posthog, "identify");
      const analytics = PosthogAnalytics.instance;
      analytics.callLifetime();
      analytics.trackCallEvent({
        eventName: "CallLifecycle",
        phase: "terminated",
      });
      expect(capture).not.toHaveBeenCalled();
      if (action === "logout") analytics.logout();
      else if (action === "reset") PosthogAnalytics.resetInstance();
      else {
        PosthogAnalytics.setUsageAnalyticsEnabled(false);
        PosthogAnalytics.setUsageAnalyticsEnabled(true);
      }
      accountData.resolve({ id: "accepted-after-revocation" });
      await vi.waitFor(() =>
        expect(client.getAccountDataFromServer).toHaveBeenCalled(),
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(capture).not.toHaveBeenCalled();
      if (action !== "optOutThenIn") expect(identify).not.toHaveBeenCalled();
    },
  );

  it("invalidates an accepted call across opt-out then opt-in while allowing a fresh crash-only attempt", () => {
    window.matrixclient = mockClient(null);
    PosthogAnalytics.configure({
      ...credentials,
      matrixBackend: "embedded",
      hostAnalyticsId: "host-id",
      hostUsageAnalyticsEnabled: true,
    });
    const analytics = PosthogAnalytics.instance;
    const capture = vi.spyOn(posthog, "capture");
    const failure = vi.fn();
    const makeCall = (): CallTelemetry => {
      const isCurrent = analytics.callLifetime();
      return new CallTelemetry({
        callKind: "dm",
        componentVersion: "1",
        hostAppVersion: "1",
        hostAppBuild: "1",
        isCurrent,
        track: (event) => analytics.trackCallEvent(event),
        reportFailure: failure,
      });
    };
    const old = makeCall();
    const count = capture.mock.calls.length;
    optInAnalytics.setValue(false);
    optInAnalytics.setValue(true);
    old.connection(true);
    old.fail({ cause: "other", stage: "media", step: "unknown" });
    expect(capture).toHaveBeenCalledTimes(count);
    expect(failure).not.toHaveBeenCalled();
    optInAnalytics.setValue(false);
    const crashOnly = makeCall();
    crashOnly.fail({
      cause: "joinTimedOut",
      stage: "homeserver",
      step: "membership",
    });
    expect(capture).toHaveBeenCalledTimes(count);
    expect(failure).toHaveBeenCalledTimes(1);
  });

  it.each(["logout", "reset"])(
    "invalidates late accepted-attempt error callbacks after %s",
    (action) => {
      window.matrixclient = mockClient(null);
      PosthogAnalytics.configure({
        ...credentials,
        matrixBackend: "embedded",
        hostAnalyticsId: "host-id",
        hostUsageAnalyticsEnabled: true,
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
      if (action === "logout") analytics.logout();
      else PosthogAnalytics.resetInstance();
      call.fail({ cause: "other", stage: "media", step: "unknown" });
      expect(isCurrent()).toBe(false);
      expect(failure).not.toHaveBeenCalled();
    },
  );

  it("keeps its own ID in account data when it owns the session", async () => {
    const client = mockClient(null);
    window.matrixclient = client;
    PosthogAnalytics.configure({ ...credentials, matrixBackend: "jssdk" });

    PosthogAnalytics.instance.startListeningToSettingsChanges();

    // No ID on the server yet, so one is minted and stored for other devices
    await vi.waitFor(() => expect(client.setAccountData).toHaveBeenCalled());
  });

  it("reuses the ID already in account data", async () => {
    const client = mockClient("stored-earlier");
    window.matrixclient = client;
    PosthogAnalytics.configure({ ...credentials, matrixBackend: "jssdk" });
    const identify = vi.spyOn(posthog, "identify");

    PosthogAnalytics.instance.startListeningToSettingsChanges();
    await vi.waitFor(() =>
      expect(identify).toHaveBeenCalledWith("stored-earlier"),
    );

    expect(client.setAccountData).not.toHaveBeenCalled();
  });

  it("records how it reaches Matrix as a super property", async () => {
    window.matrixclient = mockClient("stored-earlier");
    PosthogAnalytics.configure({
      ...credentials,
      matrixBackend: "embedded",
      hostUsageAnalyticsEnabled: true,
    });
    const register = vi.spyOn(posthog, "register");

    PosthogAnalytics.instance.startListeningToSettingsChanges();

    await vi.waitFor(() =>
      expect(register).toHaveBeenCalledWith(
        expect.objectContaining({ matrixBackend: "embedded" }),
      ),
    );
  });

  function startScopedWidget(hostAnalyticsId: string): PosthogAnalytics {
    window.matrixclient = mockClient(null);
    PosthogAnalytics.configure({
      ...credentials,
      matrixBackend: "embedded",
      hostAnalyticsId,
      hostUsageAnalyticsEnabled: true,
      widgetScopedAnalyticsId: true,
    });
    const analytics = PosthogAnalytics.instance;
    analytics.callLifetime();
    return analytics;
  }

  function observePosthogRequests(status: () => number = () => 200) {
    const initPosthog = PostHog.prototype.init;
    const init = vi
      .spyOn(PostHog.prototype, "init")
      .mockImplementation(function (this: PostHog, apiKey, config, name) {
        return initPosthog.call(
          this,
          apiKey,
          {
            ...config,
            opt_out_useragent_filter: true,
          },
          name,
        );
      });
    // Select XHR at SDK dispatch to exercise XMLHttpRequest.send serialization.
    const sendRequest = PostHog.prototype._send_request;
    vi.spyOn(PostHog.prototype, "_send_request").mockImplementation(
      function (this: PostHog, options) {
        sendRequest.call(this, {
          ...options,
          transport: "XHR",
          disableTransport: ["sendBeacon"],
        });
      },
    );
    const send = vi
      .spyOn(XMLHttpRequest.prototype, "send")
      .mockImplementation(function (this: XMLHttpRequest) {
        Object.defineProperties(this, {
          readyState: { value: XMLHttpRequest.DONE },
          status: { value: status() },
          responseText: { value: "{}" },
        });
        this.dispatchEvent(new Event("readystatechange"));
      });
    return { init, send };
  }
});
