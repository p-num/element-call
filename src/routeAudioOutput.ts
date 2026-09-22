/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { platform } from "./Platform";

declare global {
  interface Window {
    /** Installed by the iOS host only for its bundled call document. */
    __letroAudioOutput?: {
      setSinkId(
        element: HTMLMediaElement,
        sinkId: string,
        isCurrent: () => boolean,
      ): Promise<void>;
    };
  }
}

export function supportsWebKitAudioOutput(): boolean {
  return (
    platform === "ios" &&
    "setSinkId" in HTMLMediaElement.prototype &&
    typeof window.__letroAudioOutput?.setSinkId === "function"
  );
}

// WebKit applies output selection across playback elements. Serialize requests
// so a slow obsolete selection cannot overwrite a newer route. LiveKit 2.22
// excludes iOS even when this API exists. The native bridge invokes the real
// browser API with WebKit activation, including after a web gesture expires.
let pending: Promise<unknown> = Promise.resolve();
export async function routeAudioOutput(
  element: HTMLMediaElement,
  sinkId: string,
  isCurrent: () => boolean,
): Promise<boolean> {
  const request = pending.then(async () => {
    if (!isCurrent()) return false;
    const bridge = window.__letroAudioOutput;
    if (!bridge) throw new Error("Native audio output routing unavailable");
    await bridge.setSinkId(element, sinkId, isCurrent);
    return isCurrent();
  });
  pending = request.catch(() => undefined);
  return request;
}
