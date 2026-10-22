/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { logger } from "matrix-js-sdk/lib/logger";

/** A blocked sound or optional host acknowledgement must not retain an ended call. */
export async function waitForCallCleanup(
  operations: readonly (Promise<unknown> | undefined)[],
  expectedDurationMs = 0,
): Promise<void> {
  const completion = Promise.allSettled(operations).then((results) => {
    for (const result of results) {
      if (result.status === "rejected")
        logger.warn("Optional call cleanup failed", result.reason);
    }
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      completion,
      new Promise<void>((resolve) => {
        // Allow the buffered sound to finish, with a bounded scheduling grace period.
        deadline = setTimeout(resolve, expectedDurationMs + 1_000);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}
