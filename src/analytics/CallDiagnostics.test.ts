/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowserClient,
  defaultStackParser,
  getGlobalScope,
  getIsolationScope,
  type makeFetchTransport,
  type Scope,
  SDK_VERSION,
  startInactiveSpan,
  withActiveSpan,
  withIsolationScope,
  withScope,
  type Event,
  type EventHint,
} from "@sentry/react";

import { createCallDiagnosticReporter } from "./CallDiagnostics";
import { CallDiagnosticTransport } from "./CallDiagnosticTransport";
import { callFailureDiagnostic } from "./CallFailureDiagnostic";
import { type TelemetryEvent } from "./CallTelemetry";

type Envelope = Parameters<ReturnType<typeof makeFetchTransport>["send"]>[0];

describe("pinned SDK handled-call wire boundary", () => {
  let originalGlobal: Scope;
  let originalIsolation: Scope;
  beforeEach(() => {
    originalGlobal = getGlobalScope().clone();
    originalIsolation = getIsolationScope().clone();
    vi.stubEnv("PROD", true);
    vi.stubEnv("MODE", "production");
  });
  afterEach(() => {
    // The browser SDK reuses its isolation scope even inside withIsolationScope.
    for (const [scope, original] of [
      [getGlobalScope(), originalGlobal],
      [getIsolationScope(), originalIsolation],
    ]) {
      scope.clear();
      scope.update(original);
      scope
        .getScopeData()
        .eventProcessors.splice(
          0,
          Infinity,
          ...original.getScopeData().eventProcessors,
        );
      scope.clearAttachments();
      for (const attachment of original.getScopeData().attachments)
        scope.addAttachment(attachment);
    }
    vi.unstubAllEnvs();
  });

  it("rebuilds the entire envelope despite ambient global/current/isolation attachments, scopes and tracing", async () => {
    expect(SDK_VERSION).toBe("8.55.2");
    const sent: Envelope[] = [];
    const reporter = createCallDiagnosticReporter(
      config(() => true),
      memoryTransport(sent),
    )!;
    contaminate(getGlobalScope(), "global");
    await withIsolationScope(async (isolation) => {
      contaminate(isolation, "isolation");
      await withScope(async (current) => {
        contaminate(current, "current");
        const ordinary = ordinaryClient([]);
        current.setClient(ordinary);
        const span = startInactiveSpan({
          name: "private-span",
          forceTransaction: true,
        });
        withActiveSpan(span, () => reporter.capture(failure(), () => true));
        await reporter.flush();
        span.end();
      });
    });
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0][0]).sort()).toEqual(["event_id", "sent_at"]);
    expect(sent[0][1]).toHaveLength(1);
    expect(sent[0][1][0][0]).toEqual({ type: "event" });
    expect(sent[0][1][0][1]).toMatchObject({
      message: "Unsuccessful call",
      release: "component.1",
      exception: {
        values: [{ type: "CallFailure", mechanism: { handled: true } }],
      },
      contexts: { call: { attemptId, cause: "joinTimedOut" } },
    });
    expect(JSON.stringify(sent)).not.toMatch(
      /private-|trace|baggage|attachment|user|breadcrumb|sdkProcessingMetadata/,
    );
  });

  it("drops the SDK's internal captureException retry when an ambient processor throws", async () => {
    const sent: Envelope[] = [];
    const processor = vi.fn((event: Event, hint: EventHint) => {
      if (hint.data?.__sentry__ !== true)
        throw new Error("private-processor-error");
      return event;
    });
    getGlobalScope().addEventProcessor(processor);
    contaminate(getGlobalScope(), "global");
    const reporter = createCallDiagnosticReporter(
      config(() => true),
      memoryTransport(sent),
    )!;
    reporter.capture(failure(), () => true);
    await reporter.flush();
    expect(
      processor.mock.calls.some(([, hint]) => hint.data?.__sentry__ === true),
    ).toBe(true);
    expect(sent).toEqual([]);
  });

  it("checks crash consent at capture and again after asynchronous SDK processors", async () => {
    const sent: Envelope[] = [];
    let consent = false;
    const reporter = createCallDiagnosticReporter(
      config(() => consent),
      memoryTransport(sent),
    )!;
    reporter.capture(failure(), () => true);
    await reporter.flush();
    expect(sent).toEqual([]);
    let release: () => void = () => {
      throw new Error("processor was not reached");
    };
    getGlobalScope().addEventProcessor(
      async (event) =>
        await new Promise((resolve) => {
          release = () => resolve(event);
        }),
    );
    consent = true;
    reporter.capture(failure(), () => true);
    consent = false;
    release();
    await reporter.flush();
    expect(sent).toEqual([]);
  });

  it("rejects an invalidated accepted-attempt lifetime at transport send", async () => {
    const sent: Envelope[] = [];
    let current = true;
    let release: () => void = () => {
      throw new Error("processor was not reached");
    };
    getGlobalScope().addEventProcessor(
      async (event) =>
        await new Promise((resolve) => {
          release = () => resolve(event);
        }),
    );
    const reporter = createCallDiagnosticReporter(
      config(() => true),
      memoryTransport(sent),
    )!;
    reporter.capture(failure(), () => current);
    current = false;
    release();
    await reporter.flush();
    expect(sent).toEqual([]);
  });

  it("does not change the ordinary client's scopes, processors or transport", async () => {
    const privateSent: Envelope[] = [];
    const ordinarySent: Envelope[] = [];
    contaminate(getGlobalScope(), "global");
    const ordinary = ordinaryClient(ordinarySent);
    const reporter = createCallDiagnosticReporter(
      config(() => true),
      memoryTransport(privateSent),
    )!;
    reporter.capture(failure(), () => true);
    ordinary.captureEvent({ message: "private-ordinary-event" });
    await reporter.flush();
    await ordinary.flush(1000);
    expect(privateSent).toHaveLength(1);
    expect(JSON.stringify(privateSent)).not.toContain("private-");
    expect(JSON.stringify(ordinarySent)).toContain("private-ordinary-event");
    expect(JSON.stringify(ordinarySent)).toContain("private-global-attachment");
    expect(JSON.stringify(ordinarySent)).toContain("private-global-user");
  });

  it.each([false, true])(
    "disables debug/development reporting with PROD=%s",
    (prod) => {
      vi.stubEnv("PROD", prod);
      vi.stubEnv("MODE", "development");
      expect(
        createCallDiagnosticReporter(
          config(() => true),
          memoryTransport([]),
        ),
      ).toBeUndefined();
    },
  );

  it.each([
    "declined",
    "permissionRefused",
    "abandoned",
    "left",
    "private-server-message",
  ])("rejects non-failure cause %s", (cause) => {
    expect(callFailureDiagnostic({ ...failure(), cause })).toBeNull();
  });

  it("never includes an errcode, free-form error text, room ID or token in its typed diagnostic", () => {
    const diagnostic = callFailureDiagnostic({
      ...failure(),
      errcode: "M_PRIVATE",
      message: "private-message",
      roomId: "private-room",
      token: "private-token",
    });
    expect(diagnostic?.fingerprint).toEqual([
      "call-failure",
      "joinTimedOut",
      "joining",
    ]);
    expect(JSON.stringify(diagnostic)).not.toMatch(
      /private-|M_PRIVATE|errcode/,
    );
  });

  it("rejects incomplete or open-ended failure context before authorizing an envelope", () => {
    expect(
      callFailureDiagnostic({ ...failure(), callKind: undefined }),
    ).toBeNull();
    expect(
      callFailureDiagnostic({ ...failure(), stage: "private-stage" }),
    ).toBeNull();
    expect(
      callFailureDiagnostic({ ...failure(), step: "private-step" }),
    ).toBeNull();
    expect(
      callFailureDiagnostic({
        ...failure(),
        phase: { toString: () => "joining" },
      }),
    ).toBeNull();
  });
});

describe("dedicated transport envelope acceptance", () => {
  it("drops attachments, DSC and every non-event item, rejecting unknown/internal and duplicate IDs", async () => {
    const sent: Envelope[] = [];
    const boundary = new CallDiagnosticTransport(config(() => true));
    const event = boundary.authorize(failure(), () => true)!;
    const delegate = memoryTransport(sent)({} as never);
    const transport = boundary.wrap(delegate);
    const polluted = [
      {
        event_id: event.event_id,
        trace: { transaction: "private-baggage" },
        sdk: { name: "private-sdk" },
      },
      [
        [
          { type: "event", private: "private-item-header" },
          { ...event, user: { id: "private-user" } },
        ],
        [
          { type: "attachment", filename: "private-attachment" },
          "private-content",
        ],
        [{ type: "session" }, { did: "private-device" }],
        [{ type: "client_report" }, { private: "private-report" }],
      ],
    ] as unknown as Envelope;
    await transport.send(polluted);
    await transport.send(polluted);
    await transport.send([
      { event_id: "f".repeat(32), sent_at: "2026-11-17T12:00:00Z" },
      [
        [
          { type: "event" },
          { message: "private-internal-recovery", event_id: "f".repeat(32) },
        ],
      ],
    ]);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toMatch(
      /private-|trace|attachment|session|client_report/,
    );
  });
});

const attemptId = "12345678-1234-4234-8234-123456789abc";

function failure(): TelemetryEvent {
  return {
    eventName: "CallFailure",
    attemptId,
    phase: "joining",
    cause: "joinTimedOut",
    stage: "homeserver",
    step: "membership",
    callKind: "dm",
  };
}

function config(consent: () => boolean): {
  dsn: string;
  release: string;
  consent(): boolean;
} {
  return { dsn: "https://key@example.org/1", release: "component.1", consent };
}

function memoryTransport(sent: Envelope[]): typeof makeFetchTransport {
  return () => ({
    send: async (envelope) => {
      sent.push(structuredClone(envelope));
      return await Promise.resolve({ statusCode: 200 });
    },
    flush: async () => await Promise.resolve(true),
  });
}

function ordinaryClient(sent: Envelope[]): BrowserClient {
  const client = new BrowserClient({
    dsn: "https://ordinary@example.org/2",
    integrations: [],
    stackParser: defaultStackParser,
    transport: memoryTransport(sent),
    tracesSampleRate: 1,
  });
  client.init();
  return client;
}

function contaminate(scope: Scope, source: string): void {
  scope.setUser({ id: `private-${source}-user` });
  scope.setExtra("private-extra", `private-${source}-extra`);
  scope.addBreadcrumb({ message: `private-${source}-breadcrumb` });
  scope.addAttachment({
    filename: `private-${source}-attachment`,
    data: `private-${source}-body`,
  });
  scope.setPropagationContext({
    traceId: "a".repeat(32),
    dsc: {
      trace_id: "a".repeat(32),
      public_key: "key",
      transaction: `private-${source}-baggage`,
    },
  });
}
