/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, describe, expect, it, vi } from "vitest";
import { type Event } from "@sentry/react";

import {
  callFailureDiagnostic,
  configureCallDiagnostics,
  reportCallFailure,
} from "./CallDiagnostics";

const sdk = vi.hoisted(() => ({
  options: undefined as
    | undefined
    | { beforeSend: (event: Event) => Event | null },
  capture: vi.fn(),
  init: vi.fn(),
}));
vi.mock("@sentry/react", () => ({
  BrowserClient: class {
    constructor(options: typeof sdk.options) {
      sdk.options = options;
    }
    init = sdk.init;
    captureEvent = sdk.capture;
  },
  defaultStackParser: vi.fn(),
  makeFetchTransport: vi.fn(),
}));

describe("handled call diagnostics", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("retains only typed handled failure context and stable grouping", () => {
    const event = callFailureDiagnostic({
      ...failure(),
      errcode: "M_SECRET",
      message: "secret",
      roomId: "!secret:server",
      token: "secret",
    });
    expect(event).toMatchObject({
      level: "warning",
      fingerprint: ["call-failure", "joinTimedOut", "joining"],
      exception: { values: [{ mechanism: { handled: true } }] },
    });
    expect(JSON.stringify(event)).not.toMatch(/secret|errcode|roomId|token/);
    expect(event?.fingerprint).not.toContain(attemptId);
  });

  it.each([
    "declined",
    "permissionRefused",
    "abandoned",
    "left",
    "secret-server-message",
  ])("rejects non-failure cause %s", (cause) => {
    expect(callFailureDiagnostic({ ...failure(), cause })).toBeNull();
  });

  it("stays disabled in Debug even when crash consent is enabled", () => {
    vi.stubEnv("PROD", false);
    configureCallDiagnostics({
      dsn: "https://key@example.org/1",
      release: "component.1",
      consent: () => true,
    });
    reportCallFailure(failure());
    expect(sdk.capture).not.toHaveBeenCalled();
  });

  it("stays disabled for development-flavor builds even when Vite sets PROD", () => {
    vi.stubEnv("PROD", true);
    vi.stubEnv("MODE", "development");
    configureCallDiagnostics({
      dsn: "https://key@example.org/1",
      release: "component.1",
      consent: () => true,
    });
    reportCallFailure(failure());
    expect(sdk.capture).not.toHaveBeenCalled();
  });

  it("checks crash consent independently at capture and at send, stripping ambient SDK data", () => {
    vi.stubEnv("PROD", true);
    let consent = false;
    configureCallDiagnostics({
      dsn: "https://key@example.org/1",
      release: "component.1",
      consent: () => consent,
    });
    reportCallFailure(failure());
    expect(sdk.capture).not.toHaveBeenCalled();
    consent = true;
    reportCallFailure(failure());
    expect(sdk.capture).toHaveBeenCalledTimes(1);
    const event = sdk.capture.mock.calls[0][0] as Event;
    const result = sdk.options!.beforeSend({
      ...event,
      request: { url: "secret" },
      user: { id: "secret" },
      breadcrumbs: [{ message: "secret" }],
      tags: { secret: "secret" },
      contexts: { ...event.contexts, secret: { token: "secret" } },
      extra: { logs: "secret" },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    consent = false;
    expect(sdk.options!.beforeSend(event)).toBeNull();
  });
});

const attemptId = "12345678-1234-4234-8234-123456789abc";
function failure(): Record<string, string> {
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
