/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { platform } from "./Platform";

export function supportsWebKitAudioOutput(): boolean {
  return platform === "ios" && "setSinkId" in HTMLMediaElement.prototype;
}

// WebKit applies output selection across playback elements. Serialize requests
// so a slow obsolete selection cannot overwrite a newer route. LiveKit 2.22
// excludes iOS even when this browser API exists, so call the API directly.
let pending: Promise<unknown> = Promise.resolve();
export async function routeAudioOutput(
  element: HTMLMediaElement,
  sinkId: string,
  isCurrent: () => boolean,
): Promise<boolean> {
  const request = pending.then(async () => {
    if (!isCurrent()) return false;
    await element.setSinkId(sinkId);
    return isCurrent();
  });
  pending = request.catch(() => undefined);
  return request;
}
