/*
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"]) {
  test(`Start a branded call then leave (${theme})`, async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/#?brand=letro&theme=${theme}`);
    await expect(page).toHaveTitle(/^Letro/);

    await page.getByTestId("home_callName").click();
    await page.getByTestId("home_callName").fill("HelloCall");
    await page.getByTestId("home_displayName").click();
    await page.getByTestId("home_displayName").fill("John Doe");
    await page.getByTestId("home_go").click();

    await expect(page.locator("video")).toBeVisible();
    await expect(page.getByTestId("lobby_joinCall")).toBeVisible();

    await expect(page.locator("body")).toHaveClass(
      new RegExp(`cpd-theme-${theme}`),
    );
    await testInfo.attach("letro-prejoin", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    // Check the button toolbar
    // await expect(page.getByRole('switch', { name: 'Mute microphone' })).toBeVisible();
    // await expect(page.getByRole('switch', { name: 'Stop video' })).toBeVisible();
    await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
    await expect(page.getByRole("button", { name: "End call" })).toBeVisible();

    // Join the call
    await page.getByTestId("lobby_joinCall").click();

    // Ensure that the call is connected
    await page
      .locator("div")
      .filter({ hasText: /^HelloCall$/ })
      .click();
    await expect(page).toHaveTitle(/^Letro/);
    // Check the number of participants
    await expect(page.locator("div").filter({ hasText: /^1$/ })).toBeVisible();
    // The tooltip with the name should be visible
    await expect(page.getByTestId("name_tag")).toContainText("John Doe");

    await expect(page.locator("body")).toHaveClass(
      new RegExp(`cpd-theme-${theme}`),
    );
    await testInfo.attach("letro-active", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    // Resize the window to resemble a small mobile phone
    await page.setViewportSize({ width: 350, height: 660 });
    // We should still be able to send reactions at this screen size
    await expect(page.getByRole("button", { name: "Reactions" })).toBeVisible();

    await expect(page.getByTestId("settings-bottom-center")).toBeInViewport({
      ratio: 1,
    });
    await expect(page.getByTestId("incall_leave")).toBeInViewport({ ratio: 1 });
    await expect(page.locator("video")).toBeInViewport({ ratio: 1 });
    await expect
      .poll(async () =>
        page.evaluate(() => document.documentElement.scrollWidth),
      )
      .toBeLessThanOrEqual(350);
    await testInfo.attach("letro-mobile-active", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    // leave the call
    await page.getByTestId("incall_leave").click();
    await expect(page.getByRole("heading")).toContainText(
      "John Doe, your call has ended. How did it go?",
    );
    await expect(page.getByRole("main")).toContainText(
      "Why not finish by setting up a password to keep your account?",
    );

    await expect(
      page.getByRole("link", { name: "Not now, return to home screen" }),
    ).toBeVisible();
    await page
      .getByRole("link", { name: "Not now, return to home screen" })
      .click();
    await page.getByTestId("home_callName").waitFor();
    await page.reload();
    await page.getByTestId("home_callName").waitFor();
    await expect(page).toHaveTitle(/^Letro/);
  });
}

test("BugFix: When unmuting in lobby, you had to click twice to unmute in call", async ({
  page,
}) => {
  await page.goto("/");

  await page.getByTestId("home_callName").click();
  await page.getByTestId("home_callName").fill("DoubleUnMute");
  await page.getByTestId("home_displayName").click();
  await page.getByTestId("home_displayName").fill("me");
  await page.getByTestId("home_go").click();

  const microphoneButton = page.getByTestId("incall_mute");
  const cameraButton = page.getByTestId("incall_videomute");

  // Wait for devices to enumerate before the button enables.
  await expect(microphoneButton).toBeEnabled({ timeout: 10_000 });

  await microphoneButton.click();
  await cameraButton.click();

  // Should be muted now
  await expect(microphoneButton).toHaveAccessibleName("Unmute microphone");
  await expect(cameraButton).toHaveAccessibleName("Start video");

  // Create the call and join
  await page.getByTestId("lobby_joinCall").click();

  // Give sometime for the all to be connected
  // Check the number of participants
  await expect(page.locator("div").filter({ hasText: /^1$/ })).toBeVisible();

  // Click again on the mute button. it should unmute
  await microphoneButton.click();
  await expect(microphoneButton).toHaveAccessibleName("Mute microphone");
  await cameraButton.click();
  await expect(cameraButton).toHaveAccessibleName("Stop video");
});
