/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  BrowserClient,
  defaultStackParser,
  httpContextIntegration,
  makeFetchTransport,
  Scope,
  type Event,
  type EventHint,
} from "@sentry/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createEmbeddedSentryReporting,
  iosSentryDiagnosticRequest,
} from "./EmbeddedSentryTransport";
import { setSentryReportingEnabled } from "./SentryReporting";

describe("embedded Sentry requests", () => {
  const posthogId = "b6bd305a-4af0-4101-8c81-a04fac79f04f";
  const legacyId = "account-stable-analytics-id";
  const roomId = "!private:example.org";
  const userId = "@alice:example.org";
  const memberId = "private-member-id";
  const widgetUrl =
    "https://appassets.androidplatform.net/element-call/index.html?querySecret=private-query" +
    `#/room/${encodeURIComponent(roomId)}?posthogUserId=${posthogId}&analyticsId=${legacyId}` +
    `&userId=${encodeURIComponent(userId)}&memberId=${memberId}&password=private-fragment`;
  const asset = "app:///element-call/assets/index-Xyz.js";
  const filename =
    "file:///private/application/Call.bundle/dist/assets/index-Xyz.js";
  const androidAsset =
    "https://appassets.androidplatform.net/element-call/assets/index-Android.js";
  const privateAndroidAsset =
    "https://appassets.androidplatform.net/private-widget-path/assets/index.js";
  const privateRemoteAsset =
    "https://private-widget-host.example/element-call/assets/index.js";
  const debugId = "f89a258e-9ab7-4d31-9864-c941e9fc3402";
  const metadata = { release: "call-test-release", environment: "test" };

  afterEach(() => {
    setSentryReportingEnabled(false, false);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each(["event", "transaction"] as const)(
    "removes private widget data from the serialized %s",
    async (type) => {
      setSentryReportingEnabled(type === "event", type === "transaction");
      const { client, request } = createClient();
      client.captureEvent(
        {
          ...contaminated(),
          ...(type === "transaction"
            ? { type, start_timestamp: 1_700_000_001, timestamp: 1_700_000_002 }
            : {}),
        },
        {},
        new Scope(),
      );
      await client.flush(1_000);

      expect(request).toHaveBeenCalledOnce();
      const [, options] = request.mock.calls[0];
      const body = serializedEnvelope(options?.body);
      const [header, item, event] = body
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(options?.referrerPolicy).toBe("no-referrer");
      expect(header).toEqual({
        event_id: expect.stringMatching(/^[0-9a-f]{32}$/),
        sent_at: expect.any(String),
      });
      expect(item).toEqual({ type });
      expect(event).toMatchObject(metadata);
      if (type === "event")
        expect(event).toMatchObject({
          exception: {
            values: [
              {
                type: "TypeError",
                stacktrace: {
                  frames: [
                    { filename: asset, lineno: 4 },
                    { filename: androidAsset, lineno: 8 },
                  ],
                },
              },
            ],
          },
          debug_meta: {
            images: [
              { type: "sourcemap", code_file: asset, debug_id: debugId },
              { type: "sourcemap", code_file: androidAsset, debug_id: debugId },
            ],
          },
        });
      else
        expect(event).toMatchObject({
          transaction: "Element Call",
          start_timestamp: 1_700_000_001,
          timestamp: 1_700_000_002,
          contexts: { trace: { status: "ok" } },
          spans: [
            {
              op: "http.client",
              start_timestamp: 1_700_000_001,
              status: "not_found",
            },
            { op: "http.client", start_timestamp: 1_700_000_001 },
          ],
          measurements: { lcp: { value: 150, unit: "millisecond" } },
        });
      for (const value of [
        widgetUrl,
        "posthogUserId",
        posthogId,
        "analyticsId",
        legacyId,
        roomId,
        encodeURIComponent(roomId),
        userId,
        encodeURIComponent(userId),
        memberId,
        "private-query",
        "private-fragment",
        "private-widget-path",
        "private-widget-host",
      ]) {
        expect(body).not.toContain(value);
      }
    },
  );

  it.each(["event", "transaction"] as const)(
    "discards a processor-delayed %s after revocation and re-enablement",
    async (type) => {
      const errors = type === "event";
      const performance = type === "transaction";
      setSentryReportingEnabled(errors, performance);
      const { client, request } = createClient();
      const reachedProcessor = Promise.withResolvers<void>();
      const unblock = Promise.withResolvers<void>();
      client.addEventProcessor(async (event) => {
        reachedProcessor.resolve();
        await unblock.promise;
        return event;
      });
      const event: Event = performance
        ? { type, timestamp: 1_700_000_002, start_timestamp: 1_700_000_001 }
        : { message: "ordinary error" };

      client.captureEvent(event, {}, new Scope());
      await reachedProcessor.promise;
      setSentryReportingEnabled(false, false);
      setSentryReportingEnabled(errors, performance);
      unblock.resolve();
      expect(await client.flush(1_000)).toBe(true);
      expect(request).not.toHaveBeenCalled();

      client.captureEvent(event, {}, new Scope());
      expect(await client.flush(1_000)).toBe(true);
      expect(request).toHaveBeenCalledOnce();
    },
  );

  it("drops the SDK recovery event when a processor throws under crash consent", async () => {
    setSentryReportingEnabled(true, false);
    const { client, request } = createClient();
    const processor = vi.fn((event: Event, hint: EventHint) => {
      if (hint.data?.__sentry__ === true) return event;
      throw new Error("event processor failed");
    });
    client.addEventProcessor(processor);
    client.captureEvent({ message: "ordinary error" }, {}, new Scope());
    expect(await client.flush(1_000)).toBe(true);
    expect(processor).toHaveBeenCalledTimes(2);
    expect(request).not.toHaveBeenCalled();
  });

  it("uses the default environment when the input contains a widget URL", async () => {
    setSentryReportingEnabled(true, false);
    const { client, request } = createClient(widgetUrl);
    client.captureEvent({ message: "ordinary error" }, {}, new Scope());
    await client.flush(1_000);
    expect(request).toHaveBeenCalledOnce();
    const body = serializedEnvelope(request.mock.calls[0][1]?.body);
    expect(JSON.parse(body.split("\n")[2])).toMatchObject({
      environment: "production",
    });
    expect(body).not.toContain(widgetUrl);
  });

  it("adds one iOS diagnostic attachment to the original error envelope", async () => {
    setSentryReportingEnabled(true, false);
    const diagnostics = JSON.stringify({ schema: 1, entries: ["joined ✓"] });
    const sentryAttachment = vi.fn().mockResolvedValue(diagnostics);
    vi.stubGlobal("__letroCallAudioDiagnostics", { sentryAttachment });
    const { client, request } = createClient();
    const id = client.captureEvent(
      contaminated(),
      { attachments: [{ filename: "unsanitized", data: roomId }] },
      new Scope(),
    );
    expect(await client.flush(1_000)).toBe(true);
    expect(request).toHaveBeenCalledOnce();
    const body = serializedEnvelope(request.mock.calls[0][1]?.body);
    const [header, item, event, attachment, contents] = body.split("\n");
    expect(JSON.parse(header).event_id).toBe(id);
    expect(JSON.parse(item)).toEqual({ type: "event" });
    expect(JSON.parse(event).event_id).toBe(id);
    expect(sentryAttachment).toHaveBeenCalledExactlyOnceWith(
      id,
      expect.any(Number),
    );
    expect(JSON.parse(attachment)).toMatchObject({
      type: "attachment",
      filename: "letro-diagnostics.json",
      content_type: "application/json",
      length: new TextEncoder().encode(diagnostics).byteLength,
    });
    expect(contents).toBe(diagnostics);
    expect(body).not.toContain("unsanitized");
    expect(body).not.toContain(roomId);
  });

  it("does not send an error if crash consent changes during the iOS reply", async () => {
    setSentryReportingEnabled(true, true);
    const reachedBridge = Promise.withResolvers<void>();
    const diagnostic = Promise.withResolvers<string>();
    vi.stubGlobal("__letroCallAudioDiagnostics", {
      sentryAttachment: async () => {
        reachedBridge.resolve();
        return diagnostic.promise;
      },
    });
    const { client, request } = createClient();
    client.captureEvent(
      { message: "first generation", level: "error" },
      {},
      new Scope(),
    );
    await reachedBridge.promise;
    setSentryReportingEnabled(false, true);
    setSentryReportingEnabled(true, true);
    diagnostic.resolve('{"schema":1,"entries":["old diagnostic"]}');
    expect(await client.flush(1_000)).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    "reject",
    "malformed",
    "untrusted-shape",
    "oversize",
    "timeout",
  ] as const)(
    "sends the original error when the iOS attachment is a %s",
    async (failure) => {
      setSentryReportingEnabled(true, false);
      const sentryAttachment = vi.fn(async () => {
        switch (failure) {
          case "reject":
            throw new Error("Bridge rejected the request");
          case "malformed":
            return "invalid attachment";
          case "untrusted-shape":
            return '{"token":"private"}';
          case "oversize":
            return "x".repeat(32_769);
          case "timeout":
            return new Promise<null>(() => {});
        }
      });
      vi.stubGlobal("__letroCallAudioDiagnostics", { sentryAttachment });
      const { client, request } = createClient();
      const id = client.captureEvent(
        { message: "send me", level: "error" },
        {},
        new Scope(),
      );
      expect(await client.flush(1_000)).toBe(true);
      expect(sentryAttachment).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledOnce();
      const lines = serializedEnvelope(request.mock.calls[0][1]?.body)
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines).toHaveLength(3);
      expect(lines[0].event_id).toBe(id);
    },
  );

  it("ignores a mutable hook even when compiled for iOS", () => {
    vi.stubEnv("VITE_IOS_SENTRY_ATTACHMENTS", "true");
    vi.stubGlobal("__letroCallAudioDiagnostics", {
      sentryAttachment: vi.fn(),
    });
    expect(iosSentryDiagnosticRequest()).toBeUndefined();
  });

  it("does not invoke an accessor posing as the iOS hook", () => {
    vi.stubEnv("VITE_IOS_SENTRY_ATTACHMENTS", "true");
    const read = vi.fn(() => {
      throw new Error("Not a native data property");
    });
    Object.defineProperty(window, "__letroCallAudioDiagnostics", {
      configurable: true,
      get: read,
    });
    try {
      expect(iosSentryDiagnosticRequest()).toBeUndefined();
      expect(read).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(window, "__letroCallAudioDiagnostics");
    }
  });

  it("keeps the iOS bridge out of the performance path", async () => {
    setSentryReportingEnabled(true, true);
    const sentryAttachment = vi.fn();
    vi.stubGlobal("__letroCallAudioDiagnostics", { sentryAttachment });
    const { client, request } = createClient();
    client.captureEvent(
      {
        type: "transaction",
        start_timestamp: 1_700_000_001,
        timestamp: 1_700_000_002,
      },
      {},
      new Scope(),
    );
    expect(await client.flush(1_000)).toBe(true);
    expect(request).toHaveBeenCalledOnce();
    expect(sentryAttachment).not.toHaveBeenCalled();
  });

  it("never transmits diagnostics when Sentry rate-limits only the error", async () => {
    setSentryReportingEnabled(true, false);
    const sentryAttachment = vi
      .fn()
      .mockResolvedValue('{"schema":1,"entries":[{"source":"callWeb"}]}');
    vi.stubGlobal("__letroCallAudioDiagnostics", { sentryAttachment });
    const { client, request } = createClient();
    request.mockResolvedValueOnce(
      new Response(null, {
        status: 200,
        headers: { "X-Sentry-Rate-Limits": "60:error:organization" },
      }),
    );

    client.captureEvent(
      { level: "error", message: "first error" },
      {},
      new Scope(),
    );
    expect(await client.flush(1_000)).toBe(true);
    client.captureEvent(
      { level: "error", message: "rate-limited error" },
      {},
      new Scope(),
    );
    expect(await client.flush(1_000)).toBe(true);

    expect(sentryAttachment).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledOnce();
  });

  function serializedEnvelope(body: RequestInit["body"]): string {
    if (typeof body !== "string")
      throw new TypeError("Expected a serialized Sentry envelope");
    return body;
  }

  function createClient(environment = metadata.environment) {
    const request = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("", { status: 200 }));
    const requestDiagnostics =
      window.__letroCallAudioDiagnostics?.sentryAttachment;
    const reporting = createEmbeddedSentryReporting(
      (options, fetch) => makeFetchTransport(options, fetch ?? request),
      { ...metadata, environment },
      requestDiagnostics && { request: requestDiagnostics, fetch: request },
    );
    const client = new BrowserClient({
      ...metadata,
      environment,
      dsn: "https://public@example.org/42",
      stackParser: defaultStackParser,
      integrations: [reporting.integration, httpContextIntegration()],
      transport: reporting.transport,
      sendClientReports: false,
    });
    client.init();
    return { client, request };
  }

  function contaminated(): Event {
    return {
      message: widgetUrl,
      request: { url: widgetUrl, headers: { Referer: widgetUrl } },
      breadcrumbs: [{ category: "navigation", data: { to: widgetUrl } }],
      extra: { posthogUserId: posthogId },
      tags: { roomId },
      user: { id: userId },
      transaction: widgetUrl,
      sdkProcessingMetadata: {
        dynamicSamplingContext: {
          transaction: widgetUrl,
          trace_id: "a".repeat(32),
          public_key: "public",
        },
      },
      exception: {
        values: [
          {
            type: "TypeError",
            value: `Could not open ${widgetUrl}`,
            stacktrace: {
              frames: [
                { filename: widgetUrl, lineno: 1 },
                { filename: `${filename}?query=private-query`, lineno: 4 },
                { filename: `${androidAsset}#private-fragment`, lineno: 8 },
                { filename: privateAndroidAsset, lineno: 12 },
                { filename: privateRemoteAsset, lineno: 16 },
              ],
            },
          },
        ],
      },
      debug_meta: {
        images: [
          filename,
          androidAsset,
          privateAndroidAsset,
          privateRemoteAsset,
        ].map((code_file) => ({
          type: "sourcemap",
          code_file,
          debug_id: debugId,
        })),
      },
      contexts: {
        call: { roomId, userId, memberId, url: widgetUrl },
        trace: {
          trace_id: "a".repeat(32),
          span_id: "c".repeat(16),
          op: "pageload",
          status: "ok",
        },
      },
      measurements: {
        lcp: { value: 150, unit: "millisecond" },
        fid: { value: 200, unit: widgetUrl },
        [widgetUrl]: { value: 200, unit: "millisecond" },
      },
      spans: [
        {
          trace_id: "a".repeat(32),
          span_id: "b".repeat(16),
          description: widgetUrl,
          start_timestamp: 1_700_000_001,
          timestamp: 1_700_000_002,
          op: "http.client",
          status: "not_found",
          data: { url: widgetUrl, memberId },
        },
        {
          trace_id: "a".repeat(32),
          span_id: "d".repeat(16),
          start_timestamp: 1_700_000_001,
          timestamp: 1_700_000_002,
          op: "http.client",
          status: widgetUrl,
        },
      ],
    };
  }
});
