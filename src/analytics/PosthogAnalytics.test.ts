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
import posthog, { type CaptureResult } from "posthog-js";
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

    it("passes the explicit host usage choice for widgets and leaves standalone choice independent", () => {
      vi.stubEnv("VITE_PACKAGE", "full");
      const widgetParams = `widgetId=fixture&parentUrl=${encodeURIComponent("https://host.example.com.localhost")}`;
      window.location.hash = `#?${widgetParams}&usageAnalyticsEnabled=true`;
      expect(analyticsConfigFromEnvironment().hostUsageAnalyticsEnabled).toBe(
        true,
      );
      window.location.hash = `#?${widgetParams}`;
      expect(analyticsConfigFromEnvironment().hostUsageAnalyticsEnabled).toBe(
        false,
      );
      window.location.hash = "#?usageAnalyticsEnabled=true";
      expect(
        analyticsConfigFromEnvironment().hostUsageAnalyticsEnabled,
      ).toBeUndefined();
    });
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
          token: "secret",
        },
        $set: { token: "secret" },
        $set_once: { token: "secret" },
      } as unknown as CaptureResult;
      expect(
        santizeSensitiveData(event, Anonymity.Pseudonymous)?.properties,
      ).toEqual({
        distinct_id: "consented-analytics-id",
        schemaVersion: 1,
        phase: "connected",
      });
      expect(JSON.stringify(event)).not.toContain("secret");
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

  it("reports under the ID its host assigned, and stores nothing", async () => {
    const client = mockClient(null);
    window.matrixclient = client;
    PosthogAnalytics.configure({
      ...credentials,
      matrixBackend: "embedded",
      hostAnalyticsId: "assigned-by-host",
      hostUsageAnalyticsEnabled: true,
    });
    const identify = vi.spyOn(posthog, "identify");

    PosthogAnalytics.instance.startListeningToSettingsChanges();
    await vi.waitFor(() =>
      expect(identify).toHaveBeenCalledWith("assigned-by-host"),
    );

    // The host owns the user's account, so Element Call must not write to it
    expect(client.setAccountData).not.toHaveBeenCalled();
  });

  it("delivers typed mobile boundaries with the ingest envelope and retires the widget identity on opt-out", () => {
    const widgetId = "b6bd305a-4af0-4101-8c81-a04fac79f04f";
    window.matrixclient = mockClient(null);
    PosthogAnalytics.configure({
      ...credentials,
      matrixBackend: "embedded",
      hostAnalyticsId: widgetId,
      hostUsageAnalyticsEnabled: true,
      widgetScopedAnalyticsId: true,
    });
    const init = vi.spyOn(posthog, "init").mockImplementation(() => posthog);
    const register = vi.spyOn(posthog, "register").mockImplementation(() => {});
    const identify = vi.spyOn(posthog, "identify");
    const reset = vi.spyOn(posthog, "reset").mockImplementation(() => {});
    const analytics = PosthogAnalytics.instance;
    const config = init.mock.calls[0][1]!;
    expect(config).toMatchObject({
      persistence: "memory",
      person_profiles: "never",
      request_batching: false,
    });
    const beforeSend = config.before_send;
    if (typeof beforeSend !== "function")
      throw new Error("Expected a PostHog before_send hook");
    const captured: CaptureResult[] = [];
    const capture = vi
      .spyOn(posthog, "capture")
      .mockImplementation((event, properties) => {
        const payload = beforeSend({
          event,
          properties: {
            ...properties,
            token: credentials.apiKey,
            distinct_id: widgetId,
            $process_person_profile: false,
            $session_id: "sdk-session-id",
            $device_id: "sdk-device-id",
            $current_url: "https://call.example/?userId=@user:example.org",
          },
        } as CaptureResult);
        if (payload) captured.push(payload);
        return payload ?? undefined;
      });
    analytics.callLifetime();
    analytics.trackCallEvent({ eventName: "CallJoinAttempted" });
    analytics.trackCallEvent({
      eventName: "CallCorrelation",
      correlationKind: "binding",
      participationId: "a".repeat(64),
      canonicalRoot: "b".repeat(64),
    });
    expect(register).toHaveBeenCalledWith({ distinct_id: widgetId });
    expect(identify).not.toHaveBeenCalled();
    const envelope = {
      token: credentials.apiKey,
      distinct_id: widgetId,
      $process_person_profile: false,
    };
    expect(captured).toEqual([
      { event: "CallJoinAttempted", properties: envelope },
      {
        event: "CallCorrelation",
        properties: {
          ...envelope,
          correlationKind: "binding",
          participationId: "a".repeat(64),
          canonicalRoot: "b".repeat(64),
        },
      },
    ]);

    PosthogAnalytics.setUsageAnalyticsEnabled(false);
    analytics.trackCallEvent({ eventName: "CallParticipationEnded" });
    PosthogAnalytics.setUsageAnalyticsEnabled(true);
    analytics.callLifetime();
    analytics.trackCallEvent({ eventName: "CallParticipationEnded" });
    expect(reset).toHaveBeenCalled();
    expect(capture).toHaveBeenCalledTimes(2);
    expect(
      beforeSend({
        event: "CallParticipationEnded",
        properties: envelope,
      } as CaptureResult),
    ).toBeNull();
  });

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
      const capture = vi.spyOn(posthog, "capture");
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
});
