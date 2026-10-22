/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { expect, test, type Page } from "@playwright/test";

import { widgetTest } from "../fixtures/widget-user";
import { TestHelpers } from "./test-helpers";

interface WidgetMessage {
  action: string;
  widgetId: string;
  requestId: string;
  data?: { connected?: boolean; sequence?: number };
  response?: { left?: boolean };
}

declare global {
  interface Window {
    recordCallStatusMessage: (message: WidgetMessage) => Promise<void>;
  }
}

widgetTest.use({ callType: "dm" });

for (const shape of ["omitted", "null", "confirmed"] as const) {
  widgetTest(`Host hangup with ${shape} data`, async ({ asWidget }) => {
    test.slow();
    const { brooks, whistler } = asWidget;
    const messages = await recordWidgetMessages(brooks.page);
    await TestHelpers.startCallInCurrentRoom(brooks.page, true);
    await TestHelpers.joinCallInCurrentDM(whistler.page, true);
    await expect(
      whistler.page
        .locator('iframe[title="Element Call"]')
        .contentFrame()
        .getByRole("button", { name: "End call" }),
    ).toBeVisible();
    await expect
      .poll(() =>
        messages.some(
          (message) =>
            message.action === "io.letro.connection_state" &&
            message.data?.connected === true,
        ),
      )
      .toBe(true);
    const connection = messages.find(
      (message) =>
        message.action === "io.letro.connection_state" &&
        message.data?.connected === true,
    )!;
    expect(connection.data?.sequence).toBeGreaterThanOrEqual(0);
    const requestId = `call-status-${shape}`;
    await brooks.page.evaluate(
      ({ shape, requestId, widgetId }) => {
        const frame = document.querySelector<HTMLIFrameElement>(
          'iframe[title="Element Call"]',
        )!;
        frame.contentWindow!.postMessage(
          {
            api: "toWidget",
            action: "im.vector.hangup",
            widgetId,
            requestId,
            ...(shape === "omitted"
              ? {}
              : { data: shape === "null" ? null : { wait_for_leave: true } }),
          },
          "*",
        );
      },
      { shape, requestId, widgetId: connection.widgetId },
    );
    await expect
      .poll(
        () =>
          messages.find((message) => message.requestId === requestId)?.response,
      )
      .toEqual(shape === "confirmed" ? { left: true } : {});
    await expect(
      brooks.page.locator('iframe[title="Element Call"]'),
    ).not.toBeVisible();
    await expect(
      whistler.page.locator('iframe[title="Element Call"]'),
    ).not.toBeVisible();
  });
}

async function recordWidgetMessages(page: Page): Promise<WidgetMessage[]> {
  const messages: WidgetMessage[] = [];
  await page.exposeFunction(
    "recordCallStatusMessage",
    (message: WidgetMessage) => {
      messages.push(message);
    },
  );
  await page.evaluate(() => {
    const record = window.recordCallStatusMessage;
    window.addEventListener("message", (event: MessageEvent) => {
      const message = event.data;
      if (
        message?.widgetId &&
        ["im.vector.hangup", "io.letro.connection_state"].includes(
          message.action,
        )
      ) {
        void record(message);
      }
    });
  });
  return messages;
}
