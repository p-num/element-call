/*
Copyright 2022-2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { mockConfig } from "./utils/test";
import { setSentryReportingEnabled } from "./analytics/SentryReporting";

const sentryInitSpy = vi.hoisted(() => vi.fn());

// Place the mock after the spy is defined
vi.mock("@sentry/react", () => ({
  init: sentryInitSpy,
  reactRouterV7BrowserTracingIntegration: vi.fn(),
  rewriteFramesIntegration: vi.fn(),
}));

describe("Initializer", async () => {
  // we import here to make sure that Sentry is mocked first
  const { Initializer } = await import("./initializer.tsx");
  describe("initBeforeReact()", () => {
    it("sets font family from URL param", async () => {
      window.location.hash = "#?font=DejaVu Sans";
      await Initializer.initBeforeReact();
      expect(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--font-family",
        ),
      ).toBe('"DejaVu Sans"');
    });

    it("sets font scale from URL param", async () => {
      window.location.hash = "#?fontScale=1.2";
      await Initializer.initBeforeReact();
      expect(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--font-scale",
        ),
      ).toBe("1.2");
    });
  });

  describe("init()", () => {
    describe("sentry setup", () => {
      describe("embedded package", () => {
        beforeAll(() => {
          vi.stubEnv("VITE_PACKAGE", "embedded");
          vi.stubEnv("VITE_APP_VERSION", "call-test-release");
        });

        beforeEach(() => {
          mockConfig({});
          window.location.hash = "#";
          Initializer.reset();
        });

        afterEach(() => {
          sentryInitSpy.mockClear();
        });

        afterAll(() => {
          vi.unstubAllEnvs();
        });

        it("does not call Sentry.init() without config value", async () => {
          await Initializer.init();
          expect(sentryInitSpy).not.toHaveBeenCalled();
        });

        it("ignores config value and does not create instance", async () => {
          mockConfig({
            sentry: {
              DSN: "https://config.example.com.localhost",
              environment: "config",
            },
          });
          await Initializer.init();
          expect(sentryInitSpy).not.toHaveBeenCalled();
        });

        it("uses sentryDsn param if set", async () => {
          window.location.hash = `#?sentryDsn=${encodeURIComponent("https://dsn.example.com.localhost")}`;
          await Initializer.init();
          expect(sentryInitSpy).toHaveBeenCalledWith(
            expect.objectContaining({
              dsn: "https://dsn.example.com.localhost",
              environment: undefined,
              release: "call-test-release",
            }),
          );
        });

        it("uses sentryDsn and sentryEnvironment params if set", async () => {
          window.location.hash = `#?sentryDsn=${encodeURIComponent("https://dsn.example.com.localhost")}&sentryEnvironment=fooEnvironment`;
          await Initializer.init();
          expect(sentryInitSpy).toHaveBeenCalledWith(
            expect.objectContaining({
              dsn: "https://dsn.example.com.localhost",
              environment: "fooEnvironment",
            }),
          );
        });

        it.each([
          [true, true],
          [true, false],
          [false, true],
          [false, false],
        ])(
          "honors separate error (%s) and performance (%s) choices",
          async (errors, performance) => {
            window.location.hash = `#?sentryDsn=${encodeURIComponent("https://dsn.example.com.localhost")}&sentryCrashReportingEnabled=${errors}&sentryPerformanceReportingEnabled=${performance}`;
            await Initializer.init();
            if (!errors && !performance) {
              expect(sentryInitSpy).not.toHaveBeenCalled();
              return;
            }
            expect(sentryInitSpy).toHaveBeenCalledWith(
              expect.objectContaining({
                sampleRate: 1,
                autoSessionTracking: false,
                sendDefaultPii: false,
              }),
            );
            const options = sentryInitSpy.mock.calls[0][0];
            expect(options.tracesSampler({})).toBe(performance ? 1 : 0);
            expect(options.tracesSampler({ parentSampled: false })).toBe(0);
            const event = { event_id: "test" };
            expect(options.beforeSend(event)).toEqual(errors ? event : null);
            expect(options.beforeSendTransaction(event)).toEqual(
              performance ? event : null,
            );
          },
        );

        it("applies native preference changes to pending reports and future traces", async () => {
          window.location.hash = `#?sentryDsn=${encodeURIComponent("https://dsn.example.com.localhost")}`;
          await Initializer.init();
          const options = sentryInitSpy.mock.calls[0][0];
          const event = { event_id: "test" };
          setSentryReportingEnabled(false, false);
          expect(options.beforeSend(event)).toBeNull();
          expect(options.beforeSendTransaction(event)).toBeNull();
          expect(options.tracesSampler({ parentSampled: true })).toBe(0);
          setSentryReportingEnabled(true, false);
          expect(options.beforeSend(event)).toBe(event);
          expect(options.beforeSendTransaction(event)).toBeNull();
          expect(sentryInitSpy).toHaveBeenCalledTimes(1);
        });
      });

      describe("full package", () => {
        beforeAll(() => {
          vi.stubEnv("VITE_PACKAGE", "full");
        });

        beforeEach(() => {
          mockConfig({});
          window.location.hash = "#";
          Initializer.reset();
        });

        afterEach(() => {
          sentryInitSpy.mockClear();
        });

        afterAll(() => {
          vi.unstubAllEnvs();
        });

        it("does not create instance without config value or URL param", async () => {
          await Initializer.init();
          expect(sentryInitSpy).not.toHaveBeenCalled();
        });

        it("ignores URL params and does not create instance", async () => {
          window.location.hash = `#?sentryDsn=${encodeURIComponent("https://dsn.example.com.localhost")}&sentryEnvironment=fooEnvironment`;
          await Initializer.init();
          expect(sentryInitSpy).not.toHaveBeenCalled();
        });

        it("creates instance with config value", async () => {
          mockConfig({
            sentry: {
              DSN: "https://dsn.example.com.localhost",
              environment: "fooEnvironment",
            },
          });
          await Initializer.init();
          expect(sentryInitSpy).toHaveBeenCalledWith(
            expect.objectContaining({
              dsn: "https://dsn.example.com.localhost",
              environment: "fooEnvironment",
            }),
          );
        });
      });
    });
  });
});
