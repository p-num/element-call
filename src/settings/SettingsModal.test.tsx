/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { TooltipProvider } from "@vector-im/compound-web";
import { render, screen, fireEvent } from "@testing-library/react";
import { it, expect, vi, afterEach } from "vitest";
import { type ReactNode } from "react";
import { type MatrixClient } from "matrix-js-sdk";
import { BehaviorSubject } from "rxjs";

import type * as UrlParamsModule from "../UrlParams";
import { SettingsModal } from "./SettingsModal";
import { supportsWebKitAudioOutput } from "../routeAudioOutput";
import { useMediaDevices } from "../MediaDevicesContext";

vi.mock("../Platform", () => ({ platform: "ios" }));
vi.mock("../routeAudioOutput");
vi.mock("../MediaDevicesContext");
vi.mock("./submit-rageshake", () => ({
  useSubmitRageshake: () => ({ available: false }),
}));
vi.mock("../UrlParams", async (original) => ({
  ...(await original<typeof UrlParamsModule>()),
  useUrlParams: () => ({ controlledAudioDevices: true }),
}));
vi.mock("../Modal", () => ({
  Modal: ({ children }: { children: ReactNode }): ReactNode => children,
}));
vi.mock("../tabs/Tabs", () => ({
  TabContainer: ({ tabs }: { tabs: { content: ReactNode }[] }): ReactNode =>
    tabs[0].content,
}));

const originalControls = window.controls;
afterEach(() => {
  vi.unstubAllGlobals();
  window.controls = originalControls;
});

it.each([false, true])(
  "uses the matching output picker when WebKit routing is %s",
  (webKitRouting) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.mocked(supportsWebKitAudioOutput).mockReturnValue(webKitRouting);
    const select = vi.fn();
    vi.mocked(useMediaDevices).mockReturnValue({
      requestDeviceNames: vi.fn(),
      audioOutput: {
        available$: new BehaviorSubject(
          new Map([
            ["receiver", { type: "earpiece" }],
            ["speaker", { type: "speaker" }],
          ]),
        ),
        selected$: new BehaviorSubject({ id: "receiver" }),
        select,
      },
    } as unknown as ReturnType<typeof useMediaDevices>);
    const showPicker = vi.fn();
    window.controls = {
      ...window.controls,
      showNativeOutputDevicePicker: showPicker,
    };
    render(
      <TooltipProvider>
        <SettingsModal
          open
          onDismiss={vi.fn()}
          tab="audio"
          onTabChange={vi.fn()}
          client={{} as MatrixClient}
        />
      </TooltipProvider>,
    );
    // Browser device choices remain usable in both modes.
    expect(screen.getByRole("radio", { name: "Handset" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Loudspeaker" }));
    expect(select).toHaveBeenCalledWith("speaker");
    const nativePicker = screen.queryByRole("button", {
      name: "Change audio device",
    });
    if (webKitRouting) expect(nativePicker).toBeNull();
    else {
      expect(nativePicker).not.toBeNull();
      fireEvent.click(nativePicker!);
      expect(showPicker).toHaveBeenCalledOnce();
    }
  },
);
